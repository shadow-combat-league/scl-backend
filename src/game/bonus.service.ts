import { Injectable, HttpException, HttpStatus } from '@nestjs/common'
import { PrismaService, PrismaClient } from '../prisma/prisma.service'

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

  constructor(private readonly prismaService: PrismaService) {
    this.prisma = prismaService
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

    return {
      extraPlays: BONUS_EXTRA_PLAYS,
      message: `Bonus claimed! You received ${BONUS_EXTRA_PLAYS} extra plays.`,
    }
  }

  /**
   * Get the status of all bonuses for a wallet.
   */
  async getBonusStatus(walletAddress: string): Promise<BonusesStatus> {
    const normalizedWallet = walletAddress.toLowerCase()

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

    return { bonuses, totalBonusPlaysRemaining, totalBonusPlaysUsed }
  }

  /**
   * Get total bonus extra plays used and remaining for a wallet.
   * Used by getPlayerStatus to compute total plays remaining.
   */
  async getBonusTotals(walletAddress: string): Promise<{
    totalBonusPlaysUsed: number
    totalBonusPlaysRemaining: number
  }> {
    const normalizedWallet = walletAddress.toLowerCase()

    const records = await this.prisma.bonusPlay.findMany({
      where: { walletAddress: normalizedWallet },
    })

    const totalBonusPlaysUsed = records.reduce((sum, r) => sum + r.extraPlaysUsed, 0)
    const totalBonusPlaysRemaining = records.reduce(
      (sum, r) => sum + Math.max(0, r.extraPlaysTotal - r.extraPlaysUsed),
      0,
    )

    return { totalBonusPlaysUsed, totalBonusPlaysRemaining }
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

    return true
  }
}
