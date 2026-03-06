import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { createPublicClient, http, parseAbiItem } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { PrismaService } from '../prisma/prisma.service'

// ─────────────────────────────────────────────────────────────────────────────
// ABI — only the event we care about
// ─────────────────────────────────────────────────────────────────────────────
const DAILY_CHECKIN_EVENT = parseAbiItem('event DailyCheckIn(address indexed user, uint256 timestamp)')

// ─────────────────────────────────────────────────────────────────────────────
// Points awarded for a successful on-chain daily check-in
// ─────────────────────────────────────────────────────────────────────────────
const CHECKIN_POINTS = 100

// How many blocks to look back on startup (catches events missed while offline).
// ~1 day on Base (~43,200 blocks at 2s/block).
const CATCHUP_BLOCKS = 43_200n

// Max block range per getLogs call — Base RPC (and Anvil fork) caps at 10,000.
const MAX_BLOCK_RANGE = 9_999n

// Polling interval in milliseconds.
const POLL_INTERVAL_MS = 15_000

@Injectable()
export class BlockchainService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BlockchainService.name)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any
  private contractAddress: `0x${string}`
  private pollTimer: NodeJS.Timeout | null = null
  private lastProcessedBlock: bigint | null = null
  private isProcessing = false

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async onModuleInit() {
    const contractAddress = this.config.get<string>('SCL_DAILY_CHECKIN_ADDRESS')
    const rpcUrl = this.config.get<string>('BLOCKCHAIN_RPC_URL')
    const networkEnv = this.config.get<string>('BLOCKCHAIN_NETWORK', 'base-sepolia')

    if (!contractAddress || !rpcUrl) {
      this.logger.warn(
        'BlockchainService disabled — set SCL_DAILY_CHECKIN_ADDRESS and BLOCKCHAIN_RPC_URL to enable.',
      )
      return
    }

    this.contractAddress = contractAddress as `0x${string}`

    const chain = networkEnv === 'base' ? base : baseSepolia
    this.client = createPublicClient({ chain, transport: http(rpcUrl) })

    this.logger.log(`BlockchainService starting (network: ${networkEnv}, contract: ${this.contractAddress})`)

    // Determine catch-up start block
    const latestBlock = await this.client.getBlockNumber()
    this.lastProcessedBlock = latestBlock > CATCHUP_BLOCKS ? latestBlock - CATCHUP_BLOCKS : 0n

    this.logger.log(`Catching up from block ${this.lastProcessedBlock} to ${latestBlock}`)
    await this.processNewEvents()

    // Start polling loop
    this.pollTimer = setInterval(() => this.processNewEvents(), POLL_INTERVAL_MS)
    this.logger.log(`Polling for DailyCheckIn events every ${POLL_INTERVAL_MS / 1000}s`)
  }

  onModuleDestroy() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event polling
  // ─────────────────────────────────────────────────────────────────────────

  private async processNewEvents() {
    if (this.isProcessing || !this.client) return
    this.isProcessing = true

    try {
      const latestBlock = await this.client.getBlockNumber()
      const fromBlock = (this.lastProcessedBlock ?? latestBlock) + 1n

      if (fromBlock > latestBlock) return // Nothing new

      // Chunk into MAX_BLOCK_RANGE windows to respect RPC limits (Base caps at 10,000).
      let chunkFrom = fromBlock
      let totalFound = 0

      while (chunkFrom <= latestBlock) {
        const chunkTo = chunkFrom + MAX_BLOCK_RANGE > latestBlock ? latestBlock : chunkFrom + MAX_BLOCK_RANGE

        const logs = await this.client.getLogs({
          address: this.contractAddress,
          event: DAILY_CHECKIN_EVENT,
          fromBlock: chunkFrom,
          toBlock: chunkTo,
        })

        if (logs.length > 0) {
          totalFound += logs.length
          this.logger.log(`Found ${logs.length} DailyCheckIn event(s) in blocks ${chunkFrom}–${chunkTo}`)
          for (const log of logs) {
            await this.handleCheckInEvent(log)
          }
        }

        chunkFrom = chunkTo + 1n
      }

      if (totalFound === 0 && fromBlock < latestBlock) {
        // silent — normal during polling
      }

      this.lastProcessedBlock = latestBlock
    } catch (err) {
      this.logger.error('Error polling blockchain events', err)
    } finally {
      this.isProcessing = false
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event handler
  // ─────────────────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleCheckInEvent(log: any) {
    const txHash = log.transactionHash
    const userAddress = (log.args as { user: string })?.user?.toLowerCase()

    if (!txHash || !userAddress) {
      this.logger.warn('Received malformed DailyCheckIn log, skipping', log)
      return
    }

    this.logger.log(`DailyCheckIn event — user: ${userAddress}, tx: ${txHash}`)

    // ── Idempotency: skip already-processed transactions ──────────────────
    const alreadyProcessed = await this.prisma.blockchainCheckIn.findUnique({
      where: { txHash },
    })

    if (alreadyProcessed) {
      this.logger.debug(`Tx ${txHash} already processed — skipping`)
      return
    }

    // ── Find or create the player ─────────────────────────────────────────
    const player = await this.prisma.player.upsert({
      where: { walletAddress: userAddress },
      update: {},
      create: {
        walletAddress: userAddress,
        totalScore: 0,
        lifetimeTotalScore: 0,
      },
    })

    // ── Credit points ─────────────────────────────────────────────────────
    await this.prisma.$transaction([
      // Increment player scores
      this.prisma.player.update({
        where: { id: player.id },
        data: {
          totalScore: { increment: CHECKIN_POINTS },
          lifetimeTotalScore: { increment: CHECKIN_POINTS },
          weeklyScore: { increment: CHECKIN_POINTS },
        },
      }),
      // Record the processed tx to prevent double-crediting
      this.prisma.blockchainCheckIn.create({
        data: {
          txHash,
          walletAddress: userAddress,
          blockNumber: Number(log.blockNumber),
          pointsAwarded: CHECKIN_POINTS,
          playerId: player.id,
        },
      }),
    ])

    this.logger.log(`Credited ${CHECKIN_POINTS} points to ${userAddress} (tx: ${txHash})`)
  }
}
