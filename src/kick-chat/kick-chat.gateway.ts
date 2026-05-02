import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets'
import { Server, Socket } from 'socket.io'
import { Logger, OnModuleInit } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { KickChatService } from './kick-chat.service'
import { MetricsService } from '../metrics/metrics.service'

@WebSocketGateway({
  namespace: '/kick-chat',
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class KickChatGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit {
  @WebSocketServer()
  server: Server

  private readonly logger = new Logger(KickChatGateway.name)
  private clientChannels: Map<string, string> = new Map()

  constructor(
    private readonly kickChatService: KickChatService,
    private readonly eventEmitter: EventEmitter2,
    private readonly metricsService: MetricsService,
  ) {}

  onModuleInit() {
    this.logger.log('KickChatGateway initialized')

    this.eventEmitter.on('kick-chat.message', ({ channelName, message }) => {
      this.server.emit(`chat:${channelName}`, message)
    })

    this.eventEmitter.on('kick-chat.ready', (channelName: string) => {
      this.logger.log(`Kick chat ready for channel: ${channelName}`)
      this.server.emit(`chat:${channelName}:ready`, { channelName })
    })

    this.eventEmitter.on('kick-chat.error', ({ channelName, error }) => {
      this.logger.error(`Kick chat error for channel ${channelName}:`, error)
      this.server.emit(`chat:${channelName}:error`, { channelName, error: error?.message || 'Unknown error' })
    })
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`)
    this.metricsService.kickWebSocketClients.inc()
    this.metricsService.kickWebSocketConnections.inc()
  }

  handleDisconnect(client: Socket) {
    this.metricsService.kickWebSocketClients.dec()
    this.metricsService.kickWebSocketDisconnections.inc()
    const channelName = this.clientChannels.get(client.id)
    if (channelName) {
      this.logger.log(`Client ${client.id} disconnected from channel: ${channelName}`)
      this.clientChannels.delete(client.id)
    } else {
      this.logger.log(`Client disconnected: ${client.id}`)
    }
  }

  @SubscribeMessage('subscribe')
  async handleSubscribe(
    @MessageBody() data: { channelName: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { channelName } = data

    if (!channelName) {
      client.emit('error', { message: 'Channel name is required' })
      return
    }

    try {
      this.logger.log(`Client ${client.id} subscribing to channel: ${channelName}`)

      if (!this.kickChatService.isConnected(channelName)) {
        const connected = await this.kickChatService.connect(channelName, true)
        if (!connected) {
          client.emit('error', { message: `Failed to connect to Kick chat for channel: ${channelName}` })
          return
        }
      }

      this.clientChannels.set(client.id, channelName)
      client.join(`channel:${channelName}`)
      this.metricsService.kickWebSocketSubscriptions.inc({ channel: channelName })
      client.emit('subscribed', { channelName })

      this.logger.log(`Client ${client.id} successfully subscribed to channel: ${channelName}`)
    } catch (error) {
      this.logger.error(`Error subscribing client ${client.id} to channel ${channelName}:`, error)
      client.emit('error', { message: `Error subscribing to channel: ${error.message}` })
    }
  }

  @SubscribeMessage('unsubscribe')
  async handleUnsubscribe(
    @MessageBody() data: { channelName: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { channelName } = data

    this.logger.log(`Client ${client.id} unsubscribing from channel: ${channelName}`)

    client.leave(`channel:${channelName}`)

    if (this.clientChannels.get(client.id) === channelName) {
      this.clientChannels.delete(client.id)
    }

    client.emit('unsubscribed', { channelName })
  }
}
