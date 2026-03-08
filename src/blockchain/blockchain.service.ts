import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createPublicClient, getAddress, http, parseAbiItem, type Address, type Log, type PublicClient } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { PrismaService } from '../prisma/prisma.service'
import { MetricsService } from '../metrics/metrics.service'
import { CACHE_MANAGER } from '@nestjs/cache-manager'
import type { Cache, Store } from 'cache-manager'
import { withRpcRetry } from './rpc-retry'

const DAILY_CHECKIN_EVENT_ABI = parseAbiItem('event DailyCheckIn(address indexed user, uint256 timestamp)')

// ~1 day of blocks on Base (2s/block)
const CATCHUP_BLOCKS = BigInt(43_200)
// Base public RPC limit for eth_getLogs range
const MAX_BLOCK_RANGE = BigInt(9_999)

// Points awarded per check-in (base)
const CHECKIN_BASE_POINTS = 50
// Multiplier increases by this amount per consecutive day (+0.2x each day)
const CHECKIN_MULTIPLIER_INCREMENT = 0.2
// Multiplier cap (reached after 10 consecutive days)
const CHECKIN_MAX_MULTIPLIER = 3.0

@Injectable()
export class BlockchainService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BlockchainService.name)

  private enabled = false
  private contractAddress: Address | null = null
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private lastProcessedBlock: bigint | null = null
  private viemClient: PublicClient | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly metricsService: MetricsService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async onModuleInit(): Promise<void> {
    const rpcUrl = this.configService.get<string>('BLOCKCHAIN_RPC_URL')
    const network = this.configService.get<string>('BLOCKCHAIN_NETWORK')
    const address = this.configService.get<string>('SCL_DAILY_CHECKIN_ADDRESS')

    if (!rpcUrl || !network || !address) {
      this.logger.warn(
        'Blockchain monitoring disabled — set BLOCKCHAIN_RPC_URL, BLOCKCHAIN_NETWORK, and SCL_DAILY_CHECKIN_ADDRESS to enable.',
      )
      return
    }

    this.contractAddress = address as Address
    this.enabled = true

    const chain = network === 'base-sepolia' ? baseSepolia : base
    this.viemClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient

    this.logger.log(`Blockchain monitoring enabled on ${network} — contract: ${this.contractAddress}`)

    await this.startMonitoring(this.viemClient)
  }

  onModuleDestroy(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
  }

  private rpcRetryOptions(): { onRetry: (attempt: number, err: unknown, delayMs: number) => void } {
    return {
      onRetry: (attempt, err, delayMs) =>
        this.logger.warn(
          `RPC rate limited or unavailable, retry ${attempt} in ${Math.round(delayMs)}ms`,
          err instanceof Error ? err.message : err,
        ),
    }
  }

  private async startMonitoring(
    client: PublicClient,
  ): Promise<void> {
    // Catch-up: scan ~1 day of missed blocks on startup in 9,999-block chunks
    try {
      const latestBlock = await withRpcRetry(() => client.getBlockNumber(), this.rpcRetryOptions())
      const scanFrom = latestBlock > CATCHUP_BLOCKS ? latestBlock - CATCHUP_BLOCKS : BigInt(0)

      this.logger.log(`Catch-up scan: blocks ${scanFrom} → ${latestBlock}`)

      let chunkFrom = scanFrom
      while (chunkFrom <= latestBlock) {
        const chunkTo = chunkFrom + MAX_BLOCK_RANGE < latestBlock ? chunkFrom + MAX_BLOCK_RANGE : latestBlock
        const logs = await withRpcRetry(
          () =>
            client.getLogs({
              address: this.contractAddress!,
              event: DAILY_CHECKIN_EVENT_ABI,
              fromBlock: chunkFrom,
              toBlock: chunkTo,
            }),
          this.rpcRetryOptions(),
        )
        if (logs.length > 0) {
          this.logger.log(`Catch-up chunk ${chunkFrom}→${chunkTo}: ${logs.length} event(s)`)
          await this.processLogs(logs)
        }
        chunkFrom = chunkTo + BigInt(1)
      }

      this.lastProcessedBlock = latestBlock
    } catch (err) {
      this.logger.error('Catch-up scan failed:', err)
    }

    // Poll every 15s
    this.pollInterval = setInterval(() => {
      if (this.viemClient) void this.poll(this.viemClient)
    }, 15_000)
  }

  private async poll(client: PublicClient): Promise<void> {
    if (!this.enabled || !this.contractAddress) return

    try {
      const latestBlock = await withRpcRetry(() => client.getBlockNumber(), this.rpcRetryOptions())

      if (this.lastProcessedBlock !== null && latestBlock <= this.lastProcessedBlock) {
        return
      }

      const fromBlock = this.lastProcessedBlock !== null ? this.lastProcessedBlock + BigInt(1) : latestBlock
      const logs = await withRpcRetry(
        () =>
          client.getLogs({
            address: this.contractAddress!,
            event: DAILY_CHECKIN_EVENT_ABI,
            fromBlock,
            toBlock: latestBlock,
          }),
        this.rpcRetryOptions(),
      )

      if (logs.length > 0) {
        this.logger.log(`Poll found ${logs.length} new DailyCheckIn event(s)`)
        await this.processLogs(logs)
      }

      this.lastProcessedBlock = latestBlock
    } catch (err) {
      this.logger.error('Poll error:', err)
    }
  }

  private async processLogs(
    logs: Log<bigint, number, false, typeof DAILY_CHECKIN_EVENT_ABI>[],
  ): Promise<void> {
    for (const log of logs) {
      const txHash = log.transactionHash
      if (!txHash) continue

      // Skip if already processed (idempotency)
      const existing = await this.prisma.blockchainCheckIn.findUnique({
        where: { txHash },
      })
      if (existing) continue

      const user = (log.args as { user: Address }).user
      const timestampBigInt = (log.args as { timestamp: bigint }).timestamp
      const checkInAt = new Date(Number(timestampBigInt) * 1000)
      const walletAddress = getAddress(user)

      // Calculate streak before this check-in to determine multiplier
      const priorCheckIns = await this.prisma.blockchainCheckIn.findMany({
        where: { walletAddress, checkInAt: { lt: checkInAt } },
        select: { checkInAt: true },
      })
      const streakBefore = this.calculateUTCStreak(priorCheckIns.map(r => r.checkInAt), checkInAt)
      const streak = streakBefore + 1
      const multiplier = Math.min(1.0 + (streak - 1) * CHECKIN_MULTIPLIER_INCREMENT, CHECKIN_MAX_MULTIPLIER)
      const points = Math.round(CHECKIN_BASE_POINTS * multiplier)

      try {
        await this.prisma.$transaction(async tx => {
          // Upsert player (create if first time)
          await tx.player.upsert({
            where: { walletAddress },
            create: {
              walletAddress,
              weeklyScore: points,
            },
            update: {
              weeklyScore: { increment: points },
            },
          })

          // Record the processed check-in for idempotency
          await tx.blockchainCheckIn.create({
            data: {
              txHash,
              walletAddress,
              blockNumber: log.blockNumber ?? BigInt(0),
              checkInAt,
            },
          })
        })

        this.logger.log(`Credited ${points} pts (${multiplier.toFixed(1)}x streak ${streak}) to ${walletAddress} (tx: ${txHash})`)

        this.metricsService.blockchainCheckInProcessed.inc()

        // Invalidate player status cache so the frontend sees the updated weekly score
        try {
          await this.cacheManager.del(`player:${walletAddress}`)
        } catch (cacheError) {
          this.logger.error(`[Cache] Failed to invalidate player cache for ${walletAddress}:`, cacheError)
        }

        // Invalidate check-in status cache so the next poll returns the updated state
        try {
          await this.cacheManager.del(`checkin:status:${walletAddress.toLowerCase()}`)
        } catch (cacheError) {
          this.logger.error(`[Cache] Failed to invalidate check-in status cache for ${walletAddress}:`, cacheError)
        }

        // Invalidate all leaderboard caches (both weekly and lifetime) so the +100 score is reflected
        try {
          const store = (this.cacheManager as Cache & {
            store?: Store & {
              keys?: (pattern: string) => Promise<string[]>
              mdel?: (...keys: string[]) => Promise<void>
            }
          }).store

          if (store && 'keys' in store && 'mdel' in store && typeof store.keys === 'function' && typeof store.mdel === 'function') {
            const leaderboardKeys = await store.keys('leaderboard:*')
            if (leaderboardKeys && leaderboardKeys.length > 0) {
              await store.mdel(...leaderboardKeys)
              this.logger.log(`[Cache] Invalidated ${leaderboardKeys.length} leaderboard cache key(s) after daily check-in for ${walletAddress}`)
            }
          }
        } catch (cacheError) {
          this.logger.error('[Cache] Error invalidating leaderboard cache after daily check-in:', cacheError)
        }
      } catch (err) {
        this.logger.error(`Failed to process check-in for ${walletAddress} (tx: ${txHash}):`, err)
      }
    }
  }

  /**
   * Counts consecutive UTC days of check-ins immediately before `checkInAt`.
   * Uses integer day indices (Unix timestamp / 86400) for precision.
   */
  private calculateUTCStreak(priorCheckIns: Date[], checkInAt: Date): number {
    const checkInDay = Math.floor(checkInAt.getTime() / 86_400_000)
    const priorDaySet = new Set(priorCheckIns.map(d => Math.floor(d.getTime() / 86_400_000)))
    let streak = 0
    let day = checkInDay - 1
    while (priorDaySet.has(day)) {
      streak++
      day--
    }
    return streak
  }
}
