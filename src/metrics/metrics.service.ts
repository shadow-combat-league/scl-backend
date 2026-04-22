import { Injectable, OnModuleInit } from '@nestjs/common'
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client'

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly register: Registry

  // HTTP Request Metrics
  public readonly httpRequestDuration: Histogram<string>
  public readonly httpRequestTotal: Counter<string>
  public readonly httpRequestErrors: Counter<string>

  // Cache Metrics
  public readonly cacheHits: Counter<string>
  public readonly cacheMisses: Counter<string>
  public readonly cacheOperations: Histogram<string>

  // Game Business Metrics
  public readonly scoresSubmitted: Counter<string>
  public readonly activePlayers: Gauge<string>
  public readonly leaderboardViews: Counter<string>
  public readonly playerStatusChecks: Counter<string>
  public readonly streakMultipliers: Histogram<string>

  // Database Metrics
  public readonly databaseQueryDuration: Histogram<string>
  public readonly databaseConnections: Gauge<string>

  // Redis Metrics
  public readonly redisOperations: Histogram<string>
  public readonly redisErrors: Counter<string>

  // Check-In Metrics
  public readonly checkInStatusRequests: Counter<string>
  public readonly blockchainCheckInProcessed: Counter<string>

  // Livestream / Kick Metrics
  public readonly kickChatConnections: Gauge<string>
  public readonly kickChatMessagesTotal: Counter<string>
  public readonly kickWebSocketClients: Gauge<string>
  public readonly kickWebSocketConnections: Counter<string>
  public readonly kickWebSocketDisconnections: Counter<string>
  public readonly kickWebSocketSubscriptions: Counter<string>
  public readonly kickOAuthExchanges: Counter<string>

  // Livestream Overlay Metrics
  public readonly livestreamWsClients: Gauge<string>
  public readonly livestreamWsConnections: Counter<string>
  public readonly livestreamWsDisconnections: Counter<string>
  public readonly livestreamStateUpdates: Counter<string>
  public readonly livestreamAuthAttempts: Counter<string>
  public readonly livestreamAuthValidations: Counter<string>

  // Bonus Metrics (Telegram / Base Farcaster)
  public readonly bonusClaims: Counter<string>
  public readonly bonusPlaysGranted: Counter<string>
  public readonly bonusPlaysConsumed: Counter<string>

  // Referral Metrics
  public readonly referralApplications: Counter<string>
  public readonly referralPlaysGranted: Counter<string>
  public readonly referralPlaysConsumed: Counter<string>

  // Base App Code Metrics
  public readonly baseAppCodeRedemptions: Counter<string>
  public readonly baseAppCodePlaysGranted: Counter<string>
  public readonly baseAppCodePlaysConsumed: Counter<string>

  constructor() {
    // Create a new registry
    this.register = new Registry()

    // Collect default metrics (CPU, memory, etc.)
    collectDefaultMetrics({ register: this.register })

    // HTTP Request Metrics
    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.register],
    })

    this.httpRequestTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.register],
    })

    this.httpRequestErrors = new Counter({
      name: 'http_request_errors_total',
      help: 'Total number of HTTP request errors',
      labelNames: ['method', 'route', 'error_type'],
      registers: [this.register],
    })

    // Cache Metrics
    this.cacheHits = new Counter({
      name: 'cache_hits_total',
      help: 'Total number of cache hits',
      labelNames: ['cache_key_pattern'],
      registers: [this.register],
    })

    this.cacheMisses = new Counter({
      name: 'cache_misses_total',
      help: 'Total number of cache misses',
      labelNames: ['cache_key_pattern'],
      registers: [this.register],
    })

    this.cacheOperations = new Histogram({
      name: 'cache_operation_duration_seconds',
      help: 'Duration of cache operations in seconds',
      labelNames: ['operation', 'cache_key_pattern'],
      buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
      registers: [this.register],
    })

    // Game Business Metrics
    this.scoresSubmitted = new Counter({
      name: 'game_scores_submitted_total',
      help: 'Total number of game scores submitted',
      labelNames: ['has_streak_multiplier'],
      registers: [this.register],
    })

    this.activePlayers = new Gauge({
      name: 'game_active_players',
      help: 'Number of active players (played in last 24 hours)',
      registers: [this.register],
    })

    this.leaderboardViews = new Counter({
      name: 'game_leaderboard_views_total',
      help: 'Total number of leaderboard views',
      labelNames: ['mode'], // 'weekly' or 'lifetime'
      registers: [this.register],
    })

    this.playerStatusChecks = new Counter({
      name: 'game_player_status_checks_total',
      help: 'Total number of player status checks',
      labelNames: ['can_play'],
      registers: [this.register],
    })

    this.streakMultipliers = new Histogram({
      name: 'game_streak_multiplier',
      help: 'Distribution of streak multipliers applied to scores',
      labelNames: ['streak_length'],
      buckets: [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0],
      registers: [this.register],
    })

    // Database Metrics
    this.databaseQueryDuration = new Histogram({
      name: 'database_query_duration_seconds',
      help: 'Duration of database queries in seconds',
      labelNames: ['operation', 'table'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.register],
    })

    this.databaseConnections = new Gauge({
      name: 'database_connections_active',
      help: 'Number of active database connections',
      registers: [this.register],
    })

    // Redis Metrics
    this.redisOperations = new Histogram({
      name: 'redis_operation_duration_seconds',
      help: 'Duration of Redis operations in seconds',
      labelNames: ['operation', 'key_pattern'],
      buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
      registers: [this.register],
    })

    this.redisErrors = new Counter({
      name: 'redis_errors_total',
      help: 'Total number of Redis errors',
      labelNames: ['error_type'],
      registers: [this.register],
    })

    // Check-In Metrics
    this.checkInStatusRequests = new Counter({
      name: 'checkin_status_requests_total',
      help: 'Total number of daily check-in status requests',
      labelNames: ['checked_in_today'],
      registers: [this.register],
    })

    this.blockchainCheckInProcessed = new Counter({
      name: 'blockchain_checkin_processed_total',
      help: 'Total number of on-chain DailyCheckIn events successfully credited',
      registers: [this.register],
    })

    // Livestream / Kick Metrics
    this.kickChatConnections = new Gauge({
      name: 'kick_chat_connections_active',
      help: 'Number of active Kick channel connections (server → Kick)',
      registers: [this.register],
    })

    this.kickChatMessagesTotal = new Counter({
      name: 'kick_chat_messages_total',
      help: 'Total number of chat messages received from Kick',
      labelNames: ['channel'],
      registers: [this.register],
    })

    this.kickWebSocketClients = new Gauge({
      name: 'kick_websocket_clients_active',
      help: 'Number of frontend WebSocket clients currently connected',
      registers: [this.register],
    })

    this.kickWebSocketConnections = new Counter({
      name: 'kick_websocket_connections_total',
      help: 'Total number of frontend WebSocket client connections',
      registers: [this.register],
    })

    this.kickWebSocketDisconnections = new Counter({
      name: 'kick_websocket_disconnections_total',
      help: 'Total number of frontend WebSocket client disconnections',
      registers: [this.register],
    })

    this.kickWebSocketSubscriptions = new Counter({
      name: 'kick_websocket_subscriptions_total',
      help: 'Total number of channel subscription events from frontend clients',
      labelNames: ['channel'],
      registers: [this.register],
    })

    this.kickOAuthExchanges = new Counter({
      name: 'kick_oauth_token_exchanges_total',
      help: 'Total number of Kick OAuth token exchange attempts',
      labelNames: ['status'],
      registers: [this.register],
    })

    // Livestream Overlay Metrics
    this.livestreamWsClients = new Gauge({
      name: 'livestream_ws_clients_active',
      help: 'Number of active livestream websocket clients',
      registers: [this.register],
    })

    this.livestreamWsConnections = new Counter({
      name: 'livestream_ws_connections_total',
      help: 'Total number of livestream websocket connections',
      labelNames: ['role'],
      registers: [this.register],
    })

    this.livestreamWsDisconnections = new Counter({
      name: 'livestream_ws_disconnections_total',
      help: 'Total number of livestream websocket disconnections',
      labelNames: ['role'],
      registers: [this.register],
    })

    this.livestreamStateUpdates = new Counter({
      name: 'livestream_state_updates_total',
      help: 'Total number of livestream match state updates',
      labelNames: ['source'],
      registers: [this.register],
    })

    this.livestreamAuthAttempts = new Counter({
      name: 'livestream_auth_attempts_total',
      help: 'Total number of livestream auth login attempts',
      labelNames: ['role', 'status'],
      registers: [this.register],
    })

    this.livestreamAuthValidations = new Counter({
      name: 'livestream_auth_validations_total',
      help: 'Total number of livestream token validations',
      labelNames: ['status'],
      registers: [this.register],
    })

    // Bonus Metrics (Telegram / Base Farcaster)
    this.bonusClaims = new Counter({
      name: 'bonus_claims_total',
      help: 'Total number of bonus claim attempts',
      labelNames: ['bonus_type', 'status'], // bonus_type: telegram|base_farcaster, status: success|already_claimed
      registers: [this.register],
    })

    this.bonusPlaysGranted = new Counter({
      name: 'bonus_plays_granted_total',
      help: 'Total number of extra plays granted via bonuses (Telegram/Base Farcaster)',
      registers: [this.register],
    })

    this.bonusPlaysConsumed = new Counter({
      name: 'bonus_plays_consumed_total',
      help: 'Total number of bonus plays consumed',
      labelNames: ['bonus_type'], // telegram|base_farcaster
      registers: [this.register],
    })

    // Referral Metrics
    this.referralApplications = new Counter({
      name: 'referral_applications_total',
      help: 'Total number of referral code application attempts',
      labelNames: ['status'], // success, already_used, invalid_code
      registers: [this.register],
    })

    this.referralPlaysGranted = new Counter({
      name: 'referral_plays_granted_total',
      help: 'Total number of extra plays granted via referral codes',
      registers: [this.register],
    })

    this.referralPlaysConsumed = new Counter({
      name: 'referral_plays_consumed_total',
      help: 'Total number of referral plays consumed',
      registers: [this.register],
    })

    // Base App Code Metrics
    this.baseAppCodeRedemptions = new Counter({
      name: 'base_app_code_redemptions_total',
      help: 'Total number of Base App Code redemption attempts',
      labelNames: ['status'], // success, already_redeemed, invalid_code, inactive, not_yet_available, expired
      registers: [this.register],
    })

    this.baseAppCodePlaysGranted = new Counter({
      name: 'base_app_code_plays_granted_total',
      help: 'Total number of extra plays granted via Base App Codes',
      registers: [this.register],
    })

    this.baseAppCodePlaysConsumed = new Counter({
      name: 'base_app_code_plays_consumed_total',
      help: 'Total number of Base App Code plays consumed',
      registers: [this.register],
    })
  }

  onModuleInit() {
    console.log('✅ MetricsService initialized - Prometheus metrics available at /metrics')
  }

  /**
   * Get metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    return this.register.metrics()
  }

  /**
   * Get metrics registry (for custom metrics)
   */
  getRegister(): Registry {
    return this.register
  }
}
