import { Injectable, HttpException, HttpStatus } from '@nestjs/common'
import { PrismaService, PrismaClient } from '../prisma/prisma.service'
import { WordpressService } from '../wordpress/wordpress.service'

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
  ) {
    this.prisma = prismaService
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
      throw new HttpException(
        'You have already redeemed this code',
        HttpStatus.BAD_REQUEST,
      )
    }

    // Validate code exists in WordPress
    const wpCode = await this.wordpressService.getBaseAppCode(normalizedCode)
    if (!wpCode) {
      throw new HttpException(
        'Invalid code',
        HttpStatus.NOT_FOUND,
      )
    }

    // Check if code is active
    if (!wpCode.active) {
      throw new HttpException(
        'This code is no longer active',
        HttpStatus.BAD_REQUEST,
      )
    }

    // Check if current time is within start and end
    const now = new Date()
    if (now < wpCode.start) {
      throw new HttpException(
        'This code is not yet available',
        HttpStatus.BAD_REQUEST,
      )
    }
    if (now > wpCode.end) {
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

    return {
      extraPlays: wpCode.extraPlays,
      message: `Code redeemed! You received ${wpCode.extraPlays} extra plays.`,
    }
  }

  /**
   * Get the status of all base app code redemptions for a wallet.
   */
  async getRedemptionStatus(walletAddress: string): Promise<BaseAppCodeStatus> {
    const normalizedWallet = walletAddress.toLowerCase()

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

    return { redemptions, totalExtraPlaysRemaining, totalExtraPlaysUsed }
  }

  /**
   * Get total base app code extra plays used and remaining for a wallet.
   * Used by getPlayerStatus to compute total plays remaining.
   */
  async getTotals(walletAddress: string): Promise<{
    totalExtraPlaysUsed: number
    totalExtraPlaysRemaining: number
  }> {
    const normalizedWallet = walletAddress.toLowerCase()

    const records = await this.prisma.baseAppCodeRedemption.findMany({
      where: { walletAddress: normalizedWallet },
    })

    const totalExtraPlaysUsed = records.reduce((sum, r) => sum + r.extraPlaysUsed, 0)
    const totalExtraPlaysRemaining = records.reduce(
      (sum, r) => sum + Math.max(0, r.extraPlaysTotal - r.extraPlaysUsed),
      0,
    )

    return { totalExtraPlaysUsed, totalExtraPlaysRemaining }
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

    return true
  }
}
