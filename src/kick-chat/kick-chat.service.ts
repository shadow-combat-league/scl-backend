import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common'
import { createClient, type MessageData } from '@retconned/kick-js'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { MetricsService } from '../metrics/metrics.service'

export interface KickChatMessage {
  username: string
  content: string
  timestamp: number
  id: string
  // Optional Kick identity styling
  color?: string
  // Raw badges data from Kick (shape depends on Kick's API)
  badges?: unknown
}

@Injectable()
export class KickChatService implements OnModuleDestroy {
  private readonly logger = new Logger(KickChatService.name)
  private clients: Map<string, ReturnType<typeof createClient>> = new Map()
  private messageHandlers: Map<string, Set<(message: KickChatMessage) => void>> = new Map()

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly metricsService: MetricsService,
  ) {}

  /**
   * Connect to a Kick channel's chat
   * @param channelName - Kick channel username
   * @param readOnly - If true, only read messages (no sending/moderation)
   */
  async connect(channelName: string, readOnly: boolean = true): Promise<boolean> {
    if (this.clients.has(channelName)) {
      this.logger.log(`Already connected to channel: ${channelName}`)
      return true
    }

    try {
      this.logger.log(`Connecting to Kick chat for channel: ${channelName}`)

      // Create kick-js client in read-only mode
      const client = createClient(channelName, {
        readOnly: readOnly,
        logger: false, // We'll handle logging ourselves
        plainEmote: false,
      })

      // Set up event listeners
      client.on('ready', () => {
        this.logger.log(`Kick chat client ready for channel: ${channelName}`)
        this.eventEmitter.emit('kick-chat.ready', channelName)
      })

      client.on('ChatMessage', (message: MessageData) => {
        this.handleChatMessage(channelName, message)
      })

      client.on('error', (error: any) => {
        this.logger.error(`Kick chat client error for ${channelName}:`, error)
        this.eventEmitter.emit('kick-chat.error', { channelName, error })
      })

      // Store the client
      this.clients.set(channelName, client)
      this.metricsService.kickChatConnections.inc()

      return true
    } catch (error) {
      this.logger.error(`Error connecting to Kick chat for ${channelName}:`, error)
      return false
    }
  }

  /**
   * Handle incoming chat messages
   */
  private handleChatMessage(channelName: string, message: MessageData) {
    try {
      // Try different paths for color
      const color = 
        (message as any)?.sender?.identity?.color ||
        (message as any)?.sender?.color ||
        undefined

      const badges = 
        (message as any)?.sender?.identity?.badges ||
        (message as any)?.sender?.badges ||
        undefined

      const chatMessage: KickChatMessage = {
        username: message.sender.username,
        content: message.content,
        timestamp: message.created_at ? new Date(message.created_at).getTime() : Date.now(),
        id: message.id,
        color,
        badges,
      }

      this.metricsService.kickChatMessagesTotal.inc({ channel: channelName })

      // Emit to EventEmitter for WebSocket gateway
      this.eventEmitter.emit('kick-chat.message', { channelName, message: chatMessage })

      // Also notify registered handlers
      const handlers = this.messageHandlers.get(channelName)
      if (handlers) {
        handlers.forEach(handler => handler(chatMessage))
      }
    } catch (error) {
      this.logger.error(`Error handling chat message for ${channelName}:`, error)
    }
  }

  /**
   * Disconnect from a channel
   */
  disconnect(channelName: string): void {
    const client = this.clients.get(channelName)
    if (client) {
      // kick-js doesn't have explicit disconnect, but we can remove the reference
      this.clients.delete(channelName)
      this.messageHandlers.delete(channelName)
      this.metricsService.kickChatConnections.dec()
      this.logger.log(`Disconnected from channel: ${channelName}`)
    }
  }

  /**
   * Check if connected to a channel
   */
  isConnected(channelName: string): boolean {
    return this.clients.has(channelName)
  }

  /**
   * Get all connected channels
   */
  getConnectedChannels(): string[] {
    return Array.from(this.clients.keys())
  }

  /**
   * Cleanup on module destroy
   */
  onModuleDestroy() {
    this.logger.log('Cleaning up Kick chat connections...')
    for (const channelName of this.clients.keys()) {
      this.disconnect(channelName)
    }
    this.clients.clear()
    this.messageHandlers.clear()
  }
}
