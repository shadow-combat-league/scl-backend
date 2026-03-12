import { Injectable, HttpException, HttpStatus, Inject } from '@nestjs/common'
import { CACHE_MANAGER } from '@nestjs/cache-manager'
import { Cache } from 'cache-manager'
import { PrismaService, PrismaClient } from '../prisma/prisma.service'
import { MetricsService } from '../metrics/metrics.service'

export type BonusType = 'telegram' | 'base_farcaster'

export const BONUS_EXTRA_PLAYS = 5

export interface BonusStatus {
  bonusType: BonusType
  claimed: boolean
  extraPlaysTotal: number
  extraPlaysUsed: number
  extraPlaysRemaining: number
}

export interface BonusesStatus {
  bonuses: BonusStatus[]
  totalBonusPlaysRemaining: number
  totalBonusPlaysUsed: number
}

@Injectable()
export class BonusService {
  private readonly prisma: PrismaClient

  constructor(
    private readonly prismaService: PrismaService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private metricsService: MetricsService,
  ) {
    this.prisma = prismaService
  }

  private getCacheKey(walletAddress: string): string {
    return `bonus:${walletAddress.toLowerCase()}`
  }

  private async invalidateCache(walletAddress: string): Promise<void> {
    const cacheKey = this.getCacheKey(walletAddress)
    await this.cacheManager.del(cacheKey)
  }

  /**
   * Claim a bonus for a wallet address.
   * Returns the number of extra plays granted.
   */
  async claimBonus(
    walletAddress: string,
    bonusType: BonusType,
  ): Promise<{ extraPlays: number; message: string }> {
    const normalizedWallet = walletAddress.toLowerCase()

    const existing = await this.prisma.bonusPlay.findUnique({
      where: { walletAddress_bonusType: { walletAddress: normalizedWallet, bonusType } },
    })

    if (existing) {
      this.metricsService.bonusClaims.inc({ bonus_type: bonusType, status: 'already_claimed' })
      throw new HttpException(
        'This bonus has already been claimed by this wallet',
        HttpStatus.BAD_REQUEST,
      )
    }

    await this.prisma.bonusPlay.create({
      data: {
        walletAddress: normalizedWallet,
        bonusType,
        extraPlaysTotal: BONUS_EXTRA_PLAYS,
        extraPlaysUsed: 0,
      },
    })

    // Invalidate cache after successful claim
    await this.invalidateCache(normalizedWallet)

    // Track successful claim
    this.metricsService.bonusClaims.inc({ bonus_type: bonusType, status: 'success' })
    this.metricsService.bonusPlaysGranted.inc(BONUS_EXTRA_PLAYS)

    return {
      extraPlays: BONUS_EXTRA_PLAYS,
      message: `Bonus claimed! You received ${BONUS_EXTRA_PLAYS} extra plays.`,
    }
  }

  /**
   * Get the status of all bonuses for a wallet.
   * Cached for 60 seconds to reduce DB load.
   */
  async getBonusStatus(walletAddress: string): Promise<BonusesStatus> {
    const normalizedWallet = walletAddress.toLowerCase()
    const cacheKey = this.getCacheKey(normalizedWallet)

    // Check cache first
    const cacheStart = Date.now()
    const cached = await this.cacheManager.get<BonusesStatus>(cacheKey)
    const cacheDuration = (Date.now() - cacheStart) / 1000

    this.metricsService.cacheOperations.observe(
      { operation: 'get', cache_key_pattern: 'bonus:*' },
      cacheDuration,
    )

    if (cached) {
      this.metricsService.cacheHits.inc({ cache_key_pattern: 'bonus:*' })
      return cached
    }

    this.metricsService.cacheMisses.inc({ cache_key_pattern: 'bonus:*' })

    // Fetch from database
    const records = await this.prisma.bonusPlay.findMany({
      where: { walletAddress: normalizedWallet },
    })

    const allTypes: BonusType[] = ['telegram', 'base_farcaster']

    const bonuses: BonusStatus[] = allTypes.map((bonusType) => {
      const record = records.find((r) => r.bonusType === bonusType)
      if (!record) {
        return {
          bonusType,
          claimed: false,
          extraPlaysTotal: BONUS_EXTRA_PLAYS,
          extraPlaysUsed: 0,
          extraPlaysRemaining: 0,
        }
      }
      const remaining = Math.max(0, record.extraPlaysTotal - record.extraPlaysUsed)
      return {
        bonusType,
        claimed: true,
        extraPlaysTotal: record.extraPlaysTotal,
        extraPlaysUsed: record.extraPlaysUsed,
        extraPlaysRemaining: remaining,
      }
    })

    const totalBonusPlaysRemaining = bonuses.reduce((sum, b) => sum + b.extraPlaysRemaining, 0)
    const totalBonusPlaysUsed = records.reduce((sum, r) => sum + r.extraPlaysUsed, 0)

    const result: BonusesStatus = { bonuses, totalBonusPlaysRemaining, totalBonusPlaysUsed }

    // Cache for 60 seconds
    const cacheSetStart = Date.now()
    await this.cacheManager.set(cacheKey, result, 60 * 1000)
    this.metricsService.cacheOperations.observe(
      { operation: 'set', cache_key_pattern: 'bonus:*' },
      (Date.now() - cacheSetStart) / 1000,
    )

    return result
  }

  /**
   * Get total bonus extra plays used and remaining for a wallet.
   * Used by getPlayerStatus to compute total plays remaining.
   * Uses the same cache as getBonusStatus.
   */
  async getBonusTotals(walletAddress: string): Promise<{
    totalBonusPlaysUsed: number
    totalBonusPlaysRemaining: number
  }> {
    // Reuse cached status to avoid duplicate DB queries
    const status = await this.getBonusStatus(walletAddress)
    return {
      totalBonusPlaysUsed: status.totalBonusPlaysUsed,
      totalBonusPlaysRemaining: status.totalBonusPlaysRemaining,
    }
  }

  /**
   * Mark one bonus play as used.
   * Returns true if a bonus play was consumed, false if none remaining.
   */
  async markBonusPlayUsed(walletAddress: string): Promise<boolean> {
    const normalizedWallet = walletAddress.toLowerCase()

    const allRecords = await this.prisma.bonusPlay.findMany({
      where: { walletAddress: normalizedWallet },
    })

    const available = allRecords.find((r) => r.extraPlaysUsed < r.extraPlaysTotal)
    if (!available) return false

    await this.prisma.bonusPlay.update({
      where: { id: available.id },
      data: { extraPlaysUsed: available.extraPlaysUsed + 1 },
    })

    // Invalidate cache after play is used
    await this.invalidateCache(normalizedWallet)

    // Track play consumed
    this.metricsService.bonusPlaysConsumed.inc({ bonus_type: available.bonusType })

    return true
  }
}
