import { Injectable, HttpException, HttpStatus, Inject } from '@nestjs/common'
import { CACHE_MANAGER } from '@nestjs/cache-manager'
import { Cache } from 'cache-manager'
import { PrismaService, PrismaClient } from '../prisma/prisma.service'
import { WordpressService } from '../wordpress/wordpress.service'
import { MetricsService } from '../metrics/metrics.service'

export interface BaseAppCodeRedemptionStatus {
  code: string
  extraPlaysTotal: number
  extraPlaysUsed: number
  extraPlaysRemaining: number
  redeemedAt: Date
}

export interface BaseAppCodeStatus {
  redemptions: BaseAppCodeRedemptionStatus[]
  totalExtraPlaysRemaining: number
  totalExtraPlaysUsed: number
}

@Injectable()
export class BaseAppCodeService {
  private readonly prisma: PrismaClient

  constructor(
    private readonly prismaService: PrismaService,
    private readonly wordpressService: WordpressService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private metricsService: MetricsService,
  ) {
    this.prisma = prismaService
  }

  private getCacheKey(walletAddress: string): string {
    return `base_app_code:${walletAddress.toLowerCase()}`
  }

  private async invalidateCache(walletAddress: string): Promise<void> {
    const cacheKey = this.getCacheKey(walletAddress)
    await this.cacheManager.del(cacheKey)
  }

  /**
   * Redeem a base app code for a wallet address.
   * Validates code exists in WordPress, is active, and within date range.
   */
  async redeemCode(
    walletAddress: string,
    code: string,
  ): Promise<{ extraPlays: number; message: string }> {
    const normalizedWallet = walletAddress.toLowerCase()
    const normalizedCode = code.trim()

    // Check if wallet has already redeemed this code
    const existing = await this.prisma.baseAppCodeRedemption.findUnique({
      where: {
        walletAddress_code: {
          walletAddress: normalizedWallet,
          code: normalizedCode.toLowerCase(),
        },
      },
    })

    if (existing) {
      this.metricsService.baseAppCodeRedemptions.inc({ status: 'already_redeemed' })
      throw new HttpException(
        'You have already redeemed this code',
        HttpStatus.BAD_REQUEST,
      )
    }

    // Validate code exists in WordPress
    const wpCode = await this.wordpressService.getBaseAppCode(normalizedCode)
    if (!wpCode) {
      this.metricsService.baseAppCodeRedemptions.inc({ status: 'invalid_code' })
      throw new HttpException(
        'Invalid code',
        HttpStatus.NOT_FOUND,
      )
    }

    // Check if code is active
    if (!wpCode.active) {
      this.metricsService.baseAppCodeRedemptions.inc({ status: 'inactive' })
      throw new HttpException(
        'This code is no longer active',
        HttpStatus.BAD_REQUEST,
      )
    }

    // Check if current time is within start and end
    const now = new Date()
    if (now < wpCode.start) {
      this.metricsService.baseAppCodeRedemptions.inc({ status: 'not_yet_available' })
      throw new HttpException(
        'This code is not yet available',
        HttpStatus.BAD_REQUEST,
      )
    }
    if (now > wpCode.end) {
      this.metricsService.baseAppCodeRedemptions.inc({ status: 'expired' })
      throw new HttpException(
        'This code has expired',
        HttpStatus.BAD_REQUEST,
      )
    }

    // Create redemption record
    await this.prisma.baseAppCodeRedemption.create({
      data: {
        walletAddress: normalizedWallet,
        code: normalizedCode.toLowerCase(),
        wpPostId: wpCode.id,
        extraPlaysTotal: wpCode.extraPlays,
        extraPlaysUsed: 0,
      },
    })

    // Invalidate cache after successful redemption
    await this.invalidateCache(normalizedWallet)

    // Track successful redemption
    this.metricsService.baseAppCodeRedemptions.inc({ status: 'success' })
    this.metricsService.baseAppCodePlaysGranted.inc(wpCode.extraPlays)

    return {
      extraPlays: wpCode.extraPlays,
      message: `Code redeemed! You received ${wpCode.extraPlays} extra plays.`,
    }
  }

  /**
   * Get the status of all base app code redemptions for a wallet.
   * Cached for 60 seconds to reduce DB load.
   */
  async getRedemptionStatus(walletAddress: string): Promise<BaseAppCodeStatus> {
    const normalizedWallet = walletAddress.toLowerCase()
    const cacheKey = this.getCacheKey(normalizedWallet)

    // Check cache first
    const cacheStart = Date.now()
    const cached = await this.cacheManager.get<BaseAppCodeStatus>(cacheKey)
    const cacheDuration = (Date.now() - cacheStart) / 1000

    this.metricsService.cacheOperations.observe(
      { operation: 'get', cache_key_pattern: 'base_app_code:*' },
      cacheDuration,
    )

    if (cached) {
      this.metricsService.cacheHits.inc({ cache_key_pattern: 'base_app_code:*' })
      return cached
    }

    this.metricsService.cacheMisses.inc({ cache_key_pattern: 'base_app_code:*' })

    // Fetch from database
    const records = await this.prisma.baseAppCodeRedemption.findMany({
      where: { walletAddress: normalizedWallet },
    })

    const redemptions: BaseAppCodeRedemptionStatus[] = records.map((record) => ({
      code: record.code,
      extraPlaysTotal: record.extraPlaysTotal,
      extraPlaysUsed: record.extraPlaysUsed,
      extraPlaysRemaining: Math.max(0, record.extraPlaysTotal - record.extraPlaysUsed),
      redeemedAt: record.createdAt,
    }))

    const totalExtraPlaysRemaining = redemptions.reduce(
      (sum, r) => sum + r.extraPlaysRemaining,
      0,
    )
    const totalExtraPlaysUsed = records.reduce((sum, r) => sum + r.extraPlaysUsed, 0)

    const result: BaseAppCodeStatus = { redemptions, totalExtraPlaysRemaining, totalExtraPlaysUsed }

    // Cache for 60 seconds
    const cacheSetStart = Date.now()
    await this.cacheManager.set(cacheKey, result, 60 * 1000)
    this.metricsService.cacheOperations.observe(
      { operation: 'set', cache_key_pattern: 'base_app_code:*' },
      (Date.now() - cacheSetStart) / 1000,
    )

    return result
  }

  /**
   * Get total base app code extra plays used and remaining for a wallet.
   * Used by getPlayerStatus to compute total plays remaining.
   * Uses the same cache as getRedemptionStatus.
   */
  async getTotals(walletAddress: string): Promise<{
    totalExtraPlaysUsed: number
    totalExtraPlaysRemaining: number
  }> {
    // Reuse cached status to avoid duplicate DB queries
    const status = await this.getRedemptionStatus(walletAddress)
    return {
      totalExtraPlaysUsed: status.totalExtraPlaysUsed,
      totalExtraPlaysRemaining: status.totalExtraPlaysRemaining,
    }
  }

  /**
   * Mark one base app code play as used.
   * Returns true if a play was consumed, false if none remaining.
   */
  async markPlayUsed(walletAddress: string): Promise<boolean> {
    const normalizedWallet = walletAddress.toLowerCase()

    const allRecords = await this.prisma.baseAppCodeRedemption.findMany({
      where: { walletAddress: normalizedWallet },
    })

    const available = allRecords.find((r) => r.extraPlaysUsed < r.extraPlaysTotal)
    if (!available) return false

    await this.prisma.baseAppCodeRedemption.update({
      where: { id: available.id },
      data: { extraPlaysUsed: available.extraPlaysUsed + 1 },
    })

    // Invalidate cache after play is used
    await this.invalidateCache(normalizedWallet)

    // Track play consumed
    this.metricsService.baseAppCodePlaysConsumed.inc()

    return true
  }
}
