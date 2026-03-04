import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { PrismaService, PrismaClient } from '../prisma/prisma.service'
import { GameService } from './game.service'
import { TimezoneService } from '../common/timezone.service'
import { toZonedTime, fromZonedTime } from 'date-fns-tz'
import { GameSettings } from './types/game-settings.type'

@Injectable()
export class WeeklyResetService implements OnModuleInit {
  private readonly logger = new Logger(WeeklyResetService.name)
  private readonly prisma: PrismaClient

  constructor(
    prismaService: PrismaService,
    private gameService: GameService,
    private timezoneService: TimezoneService,
  ) {
    this.prisma = prismaService
  }

  async onModuleInit() {
    // Check if weekly reset is enabled and perform initial check
    const settings = await this.gameService.getSettings()
    if (settings.weeklyResetEnabled) {
      this.logger.log('Weekly reset is enabled. Checking if reset is needed...')
      await this.checkAndPerformReset()
    } else {
      this.logger.log('Weekly reset is disabled.')
    }
  }

  /**
   * Calculate the duration of a "week" in milliseconds.
   * In production, this is 7 real days.
   * In debug mode (secondsPerDay set), this is 7 virtual days.
   */
  private getWeekDurationMs(settings: GameSettings): number {
    const dayMs = this.getDayDurationMs(settings)
    return dayMs * 7 // 7 days = 1 week
  }

  /**
   * Get the duration of a "game day" in milliseconds.
   */
  private getDayDurationMs(settings: GameSettings): number {
    const secondsPerDay = settings.secondsPerDay && settings.secondsPerDay > 0 ? settings.secondsPerDay : 86400
    return secondsPerDay * 1000
  }

  /**
   * Calculate the current week number based on launch date.
   * Week 0 is the first week (launch week).
   * In debug mode, uses virtual weeks based on secondsPerDay.
   * Uses WordPress timezone for production mode (same as livestream system).
   */
  private async calculateCurrentWeekNumber(settings: GameSettings): Promise<number> {
    const nowMs = Date.now()
    const now = new Date(nowMs)
    
    if (settings.secondsPerDay && settings.secondsPerDay > 0) {
      // Debug mode: Use virtual weeks (UTC-based)
      const launchDate = new Date(settings.launchDate)
      launchDate.setUTCHours(0, 0, 0, 0)
      const dayMs = this.getDayDurationMs(settings)
      const launchMs = launchDate.getTime()
      const daysSinceLaunch = Math.floor((nowMs - launchMs) / dayMs)
      return Math.floor(daysSinceLaunch / 7)
    } else {
      // Production mode: Use real calendar weeks with timezone
      const wpTimezone = await this.timezoneService.getWordPressTimezone()
      const resetDay = settings.weeklyResetDay ?? 0
      const resetHour = settings.weeklyResetHour ?? 1
      const resetMinute = settings.weeklyResetMinute ?? 0
      
      // Get start of day in WordPress timezone for both dates
      const launchDateTz = await this.timezoneService.getStartOfDayInTimezone(settings.launchDate)
      if (!launchDateTz) {
        throw new Error('Failed to parse launch date')
      }
      
      const nowTz = await this.timezoneService.getStartOfDayInTimezone(now)
      if (!nowTz) {
        throw new Error('Failed to parse current date')
      }
      
      // Convert to zoned time to get day of week in WordPress timezone
      const launchZoned = toZonedTime(launchDateTz, wpTimezone)
      const nowZoned = toZonedTime(nowTz, wpTimezone)
      
      const launchDay = launchZoned.getDay()
      const currentDay = nowZoned.getDay()
      const currentHour = nowZoned.getHours()
      const currentMinute = nowZoned.getMinutes()
      
      // Normalize launch date to start of its week
      let launchDaysToSubtract = (launchDay - resetDay + 7) % 7
      const launchWeekStartDate = new Date(launchZoned)
      launchWeekStartDate.setDate(launchZoned.getDate() - launchDaysToSubtract)
      launchWeekStartDate.setHours(0, 0, 0, 0)
      const launchWeekStart = fromZonedTime(launchWeekStartDate, wpTimezone)
      
      // Find start of current week
      let daysToSubtract = (currentDay - resetDay + 7) % 7
      const resetTimeMinutes = resetHour * 60 + resetMinute
      const currentTimeMinutes = currentHour * 60 + currentMinute
      
      if (daysToSubtract === 0 && currentTimeMinutes < resetTimeMinutes) {
        // If it's reset day but before reset time, go back to previous week
        daysToSubtract = 7
      }
      
      const weekStartDate = new Date(nowZoned)
      weekStartDate.setDate(nowZoned.getDate() - daysToSubtract)
      weekStartDate.setHours(0, 0, 0, 0)
      const weekStart = fromZonedTime(weekStartDate, wpTimezone)
      
      // Calculate week number
      const weekMs = 7 * 24 * 60 * 60 * 1000
      const weeksSinceLaunch = Math.floor((weekStart.getTime() - launchWeekStart.getTime()) / weekMs)
      
      return Math.max(0, weeksSinceLaunch)
    }
  }

  /**
   * Check if a reset is needed and perform it if so.
   * Uses week numbers for simple comparison.
   */
  async checkAndPerformReset(): Promise<void> {
    const settings = await this.gameService.getSettings()
    
    if (!settings.weeklyResetEnabled) {
      return
    }

    const currentWeekNumber = await this.calculateCurrentWeekNumber(settings)
    const storedWeekNumber = settings.currentWeekNumber

    // If week hasn't changed, no reset needed
    if (storedWeekNumber !== null && storedWeekNumber >= currentWeekNumber) {
      this.logger.debug(`No reset needed. Current week: ${currentWeekNumber}, Stored week: ${storedWeekNumber}`)
      return
    }

    this.logger.log(`Week changed from ${storedWeekNumber ?? 'null'} to ${currentWeekNumber}. Performing reset...`)

    // Update the stored week number first
    await this.prisma.gameSettings.update({
      where: { id: 1 },
      data: { currentWeekNumber },
    })

    // Get all players that need a reset
    // IMPORTANT: Only reset players who haven't been reset for THIS specific week
    // If week number jumped (e.g., 0 -> 37512), only reset players who were reset
    // in the storedWeekNumber or earlier, not players already reset in intermediate weeks
    let players: Awaited<ReturnType<typeof this.prisma.player.findMany>>
    
    if (storedWeekNumber !== null && currentWeekNumber > storedWeekNumber + 1) {
      // Week number jumped - only reset players who were reset in storedWeekNumber or earlier
      // This prevents double-resetting players who were already reset in intermediate weeks
      this.logger.warn(
        `Week number jumped from ${storedWeekNumber} to ${currentWeekNumber}. ` +
        `Only resetting players who were reset in week ${storedWeekNumber} or earlier.`
      )
      
      players = await this.prisma.player.findMany({
        where: {
          OR: [
            { lastResetWeekNumber: null },
            { lastResetWeekNumber: { lte: storedWeekNumber } },
          ],
        },
      })
    } else {
      // Normal case: week number increased by 1, reset all players who haven't been reset yet
      players = await this.prisma.player.findMany({
        where: {
          OR: [
            { lastResetWeekNumber: null },
            { lastResetWeekNumber: { lt: currentWeekNumber } },
          ],
        },
      })
    }

    if (players.length === 0) {
      this.logger.debug('No players need weekly reset.')
      return
    }

    this.logger.log(`Performing weekly reset for ${players.length} players...`)

    // Create snapshots before resetting
    const snapshots = players.map(player => ({
      weekNumber: currentWeekNumber,
      playerId: player.id,
      walletAddress: player.walletAddress,
      weeklyScore: player.weeklyScore ?? 0,
      weeklyStreak: player.weeklyStreak ?? 0,
      weeklyLongestStreak: player.weeklyLongestStreak ?? 0,
      lifetimeTotalScore: (player.lifetimeTotalScore ?? 0) + (player.weeklyScore ?? 0),
    }))

    // Save snapshots in batch
    if (snapshots.length > 0) {
      await this.prisma.weeklyScoreSnapshot.createMany({
        data: snapshots,
      })
      this.logger.log(`Created ${snapshots.length} weekly score snapshots for week ${currentWeekNumber}`)
    }

    // Reset all players in a single transaction
    for (const player of players) {
      // Preserve lifetime score before resetting
      const lifetimeTotalScore = (player.lifetimeTotalScore ?? 0) + (player.weeklyScore ?? 0)
      
      await this.prisma.player.update({
        where: { id: player.id },
        data: {
          lifetimeTotalScore,
          weeklyScore: 0,
          // weeklyStreak and weeklyLongestStreak are intentionally NOT reset —
          // streaks are continuous day-based counters that carry over across weeks.
          // Only the score resets for weekly leaderboard competition.
          lastResetWeekNumber: currentWeekNumber,
        },
      })
    }

    // Invalidate leaderboard cache (we'll rely on TTL expiration)
    this.logger.log(`Weekly reset completed for ${players.length} players. Week ${currentWeekNumber} started.`)
  }

  /**
   * Cron job that runs every hour to check if weekly reset is needed.
   * In debug mode with secondsPerDay, this will trigger more frequently.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleWeeklyResetCron() {
    const settings = await this.gameService.getSettings()
    
    if (!settings.weeklyResetEnabled) {
      return
    }

    this.logger.debug('Checking for weekly reset...')
    await this.checkAndPerformReset()
  }

  /**
   * Manual trigger for testing purposes.
   */
  async triggerReset(): Promise<void> {
    this.logger.log('Manual weekly reset triggered')
    await this.checkAndPerformReset()
  }
}
