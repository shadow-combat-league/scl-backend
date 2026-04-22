import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets'
import { Logger, OnModuleInit } from '@nestjs/common'
import { Server, Socket } from 'socket.io'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { LivestreamAuthService } from './livestream-auth.service'
import { LivestreamStateService } from './livestream-state.service'
import { LivestreamRole } from './livestream.types'
import { MetricsService } from '../metrics/metrics.service'

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class LivestreamGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit {
  @WebSocketServer()
  server: Server

  private readonly logger = new Logger(LivestreamGateway.name)
  private readonly clientRoles = new Map<string, LivestreamRole>()

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly livestreamAuthService: LivestreamAuthService,
    private readonly livestreamStateService: LivestreamStateService,
    private readonly metricsService: MetricsService
  ) {}

  onModuleInit() {
    this.eventEmitter.on('livestream.state.updated', (state) => {
      this.server.emit('SYNC_STATE', state)
    })
  }

  handleConnection(client: Socket) {
    const token = this.readTokenFromClient(client)
    const payload = token ? this.livestreamAuthService.validateToken(token) : null

    if (!payload) {
      client.emit('AUTH_ERROR', { message: 'Unauthorized' })
      client.disconnect(true)
      return
    }

    this.clientRoles.set(client.id, payload.role)
    this.metricsService.livestreamWsClients.inc()
    this.metricsService.livestreamWsConnections.inc({ role: payload.role })
    this.logger.log(`Livestream client connected: ${client.id} (${payload.role})`)
    client.emit('SYNC_STATE', this.livestreamStateService.getState())
  }

  handleDisconnect(client: Socket) {
    const role = this.clientRoles.get(client.id)
    if (!role) return
    this.clientRoles.delete(client.id)
    this.metricsService.livestreamWsClients.dec()
    this.metricsService.livestreamWsDisconnections.inc({ role })
    this.logger.log(`Livestream client disconnected: ${client.id} (${role})`)
  }

  @SubscribeMessage('REQUEST_SYNC')
  requestSync(@ConnectedSocket() client: Socket) {
    if (!this.isAuthenticated(client)) {
      client.emit('AUTH_ERROR', { message: 'Unauthorized' })
      return
    }
    client.emit('SYNC_STATE', this.livestreamStateService.getState())
  }

  @SubscribeMessage('UPDATE_STATE')
  updateState(@MessageBody() body: unknown, @ConnectedSocket() client: Socket) {
    const role = this.clientRoles.get(client.id)
    if (!role) {
      client.emit('AUTH_ERROR', { message: 'Unauthorized' })
      return
    }

    if (role !== 'judge') {
      client.emit('AUTH_ERROR', { message: 'Judge role required for updates' })
      return
    }

    this.livestreamStateService.updateState(body, 'websocket')
  }

  private isAuthenticated(client: Socket): boolean {
    return this.clientRoles.has(client.id)
  }

  private readTokenFromClient(client: Socket): string | null {
    const fromAuth = client.handshake.auth?.token
    if (typeof fromAuth === 'string' && fromAuth.trim().length > 0) return fromAuth.trim()

    const authHeader = client.handshake.headers.authorization
    if (typeof authHeader === 'string') {
      return this.livestreamAuthService.extractTokenFromAuthorizationHeader(authHeader)
    }

    return null
  }
}
