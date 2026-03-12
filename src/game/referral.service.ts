import { Injectable, HttpException, HttpStatus, Inject, forwardRef } from '@nestjs/common'
import { CACHE_MANAGER } from '@nestjs/cache-manager'
import { Cache } from 'cache-manager'
import { PrismaService, PrismaClient } from '../prisma/prisma.service'
import { WordpressService } from '../wordpress/wordpress.service'
import { GameService } from './game.service'
import { MetricsService } from '../metrics/metrics.service'

@Injectable()
export class ReferralService {
  private readonly prisma: PrismaClient

  constructor(
    private readonly wordpressService: WordpressService,
    @Inject(forwardRef(() => GameService))
    private readonly gameService: GameService,
    private readonly prismaService: PrismaService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private metricsService: MetricsService,
  ) {
    this.prisma = prismaService
  }

  private getCacheKey(walletAddress: string): string {
    return `referral:${walletAddress.toLowerCase()}`
  }

  private async invalidateCache(walletAddress: string): Promise<void> {
    const cacheKey = this.getCacheKey(walletAddress)
    await this.cacheManager.del(cacheKey)
  }

  /**
   * Apply a referral code to a wallet address
   * Returns the number of extra plays granted
   */
  async applyReferralCode(walletAddress: string, code: string): Promise<{ extraPlays: number; message: string }> {
    const normalizedWallet = walletAddress.toLowerCase()

    // Check if wallet already has a referral code
    const existingReferral = await this.prisma.referralCode.findUnique({
      where: { walletAddress: normalizedWallet },
    })

    if (existingReferral) {
      this.metricsService.referralApplications.inc({ status: 'already_used' })
      throw new HttpException(
        'This wallet has already used a referral code',
        HttpStatus.BAD_REQUEST,
      )
    }

    // Validate that the code exists in WordPress
    const refCodePost = await this.wordpressService.getGameRefCodeByCode(code)
    if (!refCodePost) {
      this.metricsService.referralApplications.inc({ status: 'invalid_code' })
      throw new HttpException(
        'Invalid referral code',
        HttpStatus.NOT_FOUND,
      )
    }

    // Get game settings to determine extra plays
    const settings = await this.gameService.getSettings()
    const extraPlays = settings.referralExtraPlays ?? 3

    // Create referral code record
    await this.prisma.referralCode.create({
      data: {
        walletAddress: normalizedWallet,
        code: refCodePost.slug.toLowerCase(),
        extraPlaysTotal: extraPlays,
        extraPlaysUsed: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })

    // Invalidate cache after successful application
    await this.invalidateCache(normalizedWallet)

    // Track successful application
    this.metricsService.referralApplications.inc({ status: 'success' })
    this.metricsService.referralPlaysGranted.inc(extraPlays)

    return {
      extraPlays,
      message: `Referral code applied! You received ${extraPlays} extra plays.`,
    }
  }

  /**
   * Get referral information for a wallet
   * Cached for 60 seconds to reduce DB load.
   */
  async getReferralInfo(walletAddress: string): Promise<{
    hasReferral: boolean
    code?: string
    extraPlaysTotal?: number
    extraPlaysUsed?: number
    extraPlaysRemaining?: number
  }> {
    const normalizedWallet = walletAddress.toLowerCase()
    const cacheKey = this.getCacheKey(normalizedWallet)

    // Check cache first
    const cacheStart = Date.now()
    const cached = await this.cacheManager.get<{
      hasReferral: boolean
      code?: string
      extraPlaysTotal?: number
      extraPlaysUsed?: number
      extraPlaysRemaining?: number
    }>(cacheKey)
    const cacheDuration = (Date.now() - cacheStart) / 1000

    this.metricsService.cacheOperations.observe(
      { operation: 'get', cache_key_pattern: 'referral:*' },
      cacheDuration,
    )

    if (cached !== undefined && cached !== null) {
      this.metricsService.cacheHits.inc({ cache_key_pattern: 'referral:*' })
      return cached
    }

    this.metricsService.cacheMisses.inc({ cache_key_pattern: 'referral:*' })

    // Fetch from database
    const referral = await this.prisma.referralCode.findUnique({
      where: { walletAddress: normalizedWallet },
    })

    let result: {
      hasReferral: boolean
      code?: string
      extraPlaysTotal?: number
      extraPlaysUsed?: number
      extraPlaysRemaining?: number
    }

    if (!referral) {
      result = { hasReferral: false }
    } else {
      result = {
        hasReferral: true,
        code: referral.code,
        extraPlaysTotal: referral.extraPlaysTotal,
        extraPlaysUsed: referral.extraPlaysUsed,
        extraPlaysRemaining: referral.extraPlaysTotal - referral.extraPlaysUsed,
      }
    }

    // Cache for 60 seconds
    const cacheSetStart = Date.now()
    await this.cacheManager.set(cacheKey, result, 60 * 1000)
    this.metricsService.cacheOperations.observe(
      { operation: 'set', cache_key_pattern: 'referral:*' },
      (Date.now() - cacheSetStart) / 1000,
    )

    return result
  }

  /**
   * Mark a referral play as used (called when a game session is created)
   */
  async useReferralPlay(walletAddress: string): Promise<boolean> {
    const normalizedWallet = walletAddress.toLowerCase()
    const referral = await this.prisma.referralCode.findUnique({
      where: { walletAddress: normalizedWallet },
    })

    if (!referral) {
      return false
    }

    if (referral.extraPlaysUsed >= referral.extraPlaysTotal) {
      return false
    }

    await this.prisma.referralCode.update({
      where: { walletAddress: normalizedWallet },
      data: {
        extraPlaysUsed: referral.extraPlaysUsed + 1,
      },
    })

    // Invalidate cache after play is used
    await this.invalidateCache(normalizedWallet)

    // Track play consumed
    this.metricsService.referralPlaysConsumed.inc()

    return true
  }
}
