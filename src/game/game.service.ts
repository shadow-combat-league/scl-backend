import { Injectable, BadRequestException, NotFoundException, OnModuleInit, HttpException, HttpStatus } from '@nestjs/common'
import { Inject } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { CACHE_MANAGER } from '@nestjs/cache-manager'
import { Cache, Store } from 'cache-manager'
import { Cron, CronExpression } from '@nestjs/schedule'
import { PrismaService, PrismaClient } from '../prisma/prisma.service'
import { MetricsService } from '../metrics/metrics.service'
import { TimezoneService } from '../common/timezone.service'
import { WordpressService } from '../wordpress/wordpress.service'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'
import { SubmitScoreDto } from './dto/submit-score.dto'
import { GetPlayerStatusDto } from './dto/get-player-status.dto'
import { BonusService } from './bonus.service'

// Define types from Prisma client method return types
type GameSession = Awaited<ReturnType<PrismaClient['gameSession']['create']>>
type Player = Awaited<ReturnType<PrismaClient['player']['findUnique']>>

// Import merged GameSettings type (WordPress + DB)
import { GameSettings, mergeGameSettings } from './types/game-settings.type'

@Injectable()
export class GameService implements OnModuleInit {
  private readonly prisma: PrismaClient

  /**
   * Thundering herd protection: tracks an in-progress WordPress fetch promise.
   * When the cache is cold and multiple concurrent requests arrive simultaneously,
   * only ONE actually calls WordPress — all others await the same promise.
   */
  private settingsFetchInProgress: Promise<GameSettings> | null = null

  constructor(
    prismaService: PrismaService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private configService: ConfigService,
    private metricsService: MetricsService,
    private timezoneService: TimezoneService,
    private wordpressService: WordpressService,
    private bonusService: BonusService,
  ) {
    // PrismaService extends PrismaClient, so we can safely assign it
    // This ensures TypeScript recognizes all PrismaClient methods
    this.prisma = prismaService
  }

  /**
   * Resolve the configured length of a "game day" in milliseconds.
   * Defaults to a real-world calendar day if not overridden in settings.
   */
  private getDayDurationMs(settings: GameSettings): number {
    const secondsPerDay = settings.secondsPerDay && settings.secondsPerDay > 0 ? settings.secondsPerDay : 86400
    return secondsPerDay * 1000
  }

  /**
   * Compute time-related anchors (today, yesterday, nextDayStart, daysSinceLaunch)
   * based on the configured game-day duration.
   *
   * In production, secondsPerDay is left unset so this collapses to real
   * calendar days using WordPress timezone (same as livestream system).
   * In dev/testing, you can set secondsPerDay (e.g. 120) to simulate "2 minutes = 1 day"
   * without changing game logic (uses UTC for simplicity in debug mode).
   */
  private async getGameDayInfo(settings: GameSettings) {
    const nowMs = Date.now()

    if (settings.secondsPerDay && settings.secondsPerDay > 0) {
      // Debug mode: Use UTC-based virtual days (simpler for testing)
      const launchDate = new Date(settings.launchDate)
      launchDate.setUTCHours(0, 0, 0, 0)
      const dayMs = this.getDayDurationMs(settings)
      const launchMs = launchDate.getTime()

      const daysSinceLaunch = Math.max(0, Math.floor((nowMs - launchMs) / dayMs))
      const todayMs = launchMs + daysSinceLaunch * dayMs
      const yesterdayMs = todayMs - dayMs
      const nextDayMs = todayMs + dayMs

      return {
        today: new Date(todayMs),
        yesterday: new Date(yesterdayMs),
        nextDayStart: new Date(nextDayMs),
        daysSinceLaunch,
        dayMs,
        launchMs,
      }
    } else {
      // Production mode: Use real calendar days with WordPress timezone
      const now = new Date(nowMs)
      
      // Get start of today in WordPress timezone
      const todayStart = await this.timezoneService.getStartOfDayInTimezone(now)
      if (!todayStart) {
        throw new Error('Failed to get start of today')
      }

      // Get launch date start of day in WordPress timezone
      const launchStart = await this.timezoneService.getStartOfDayInTimezone(settings.launchDate)
      if (!launchStart) {
        throw new Error('Failed to get start of launch date')
      }

      // Calculate days since launch
      const dayMs = 24 * 60 * 60 * 1000
      const daysSinceLaunch = Math.max(0, Math.floor((todayStart.getTime() - launchStart.getTime()) / dayMs))
      
      // Calculate yesterday and next day
      const yesterdayStart = new Date(todayStart.getTime() - dayMs)
      const nextDayStart = new Date(todayStart.getTime() + dayMs)

      return {
        today: todayStart,
        yesterday: yesterdayStart,
        nextDayStart,
        daysSinceLaunch,
        dayMs,
        launchMs: launchStart.getTime(),
      }
    }
  }

  /**
   * Normalize a date to its virtual day boundary based on the game settings.
   * This ensures date comparisons work correctly with secondsPerDay.
   * Uses timezone-aware day boundaries in production mode.
   */
  private async normalizeToVirtualDay(date: Date, settings: GameSettings): Promise<Date> {
    if (settings.secondsPerDay && settings.secondsPerDay > 0) {
      // Debug mode: Use UTC-based virtual days
      const launchDate = new Date(settings.launchDate)
      launchDate.setUTCHours(0, 0, 0, 0)
      const dayMs = this.getDayDurationMs(settings)
      const launchMs = launchDate.getTime()
      
      const daysSinceLaunch = Math.max(0, Math.floor((date.getTime() - launchMs) / dayMs))
      const virtualDayMs = launchMs + daysSinceLaunch * dayMs
      
      return new Date(virtualDayMs)
    } else {
      // Production mode: Normalize to start of day in WordPress timezone
      const normalized = await this.timezoneService.getStartOfDayInTimezone(date)
      return normalized || date
    }
  }

  async getPlayerStatus(walletAddress: string): Promise<GetPlayerStatusDto> {
    try {
      const settings = await this.getSettings()
      const player = await this.findOrCreatePlayer(walletAddress)
      const { today, yesterday, nextDayStart, daysSinceLaunch } = await this.getGameDayInfo(settings)

    // Total lifetime plays allowed: 1 per day since launch (inclusive)
    const basePlaysAllowed = Math.max(1, daysSinceLaunch + 1)

    // Count all plays since launch (lifetime usage of tries)
    // Use virtual day boundary for comparison
    // IMPORTANT: Count plays FIRST, then get referral data to avoid race conditions
    const normalizedLaunchDate = await this.normalizeToVirtualDay(today, settings)
    const totalPlaysUsed = await this.prisma.gameSession.count({
      where: {
        playerId: player.id,
        playDate: {
          gte: normalizedLaunchDate,
        },
      },
    })

    // Check for referral code extra plays
    // Get referral data AFTER counting plays to ensure we have the latest data
    // IMPORTANT: Read referral data with a fresh query to avoid stale data from transactions
    const referral = await this.prisma.referralCode.findUnique({
      where: { walletAddress: player.walletAddress.toLowerCase() },
    })
    
    // CRITICAL: Ensure referralPlaysUsed doesn't exceed totalPlaysUsed
    // This prevents negative basePlaysUsed and incorrect calculations
    // If referralPlaysUsed > totalPlaysUsed, it means there's a data inconsistency
    // (e.g., referral was updated but session wasn't created, or vice versa)
    const referralPlaysUsed = referral ? referral.extraPlaysUsed : 0
    const referralExtraPlaysRemaining = referral
      ? Math.max(0, referral.extraPlaysTotal - referral.extraPlaysUsed)
      : 0
    
    // Check for bonus extra plays
    const bonusTotals = await this.bonusService.getBonusTotals(player.walletAddress.toLowerCase())
    const bonusPlaysUsed = bonusTotals.totalBonusPlaysUsed
    const bonusPlaysRemaining = bonusTotals.totalBonusPlaysRemaining

    // Total extra plays used = referral + bonus
    const totalExtraPlaysUsed = referralPlaysUsed + bonusPlaysUsed

    // Cap extra plays used at totalPlaysUsed to prevent data inconsistency
    // This ensures basePlaysUsed is never negative
    const safeReferralPlaysUsed = Math.min(referralPlaysUsed, totalPlaysUsed)
    const safeTotalExtraPlaysUsed = Math.min(totalExtraPlaysUsed, totalPlaysUsed)
    
    // Log if we had to cap the value (indicates a data inconsistency)
    if (referral && referralPlaysUsed > totalPlaysUsed) {
      console.error('[Referral] DATA INCONSISTENCY DETECTED - capping referralPlaysUsed:', {
        walletAddress: player.walletAddress,
        totalPlaysUsed,
        referralPlaysUsed,
        safeReferralPlaysUsed,
        referralExtraPlaysTotal: referral.extraPlaysTotal,
        referralExtraPlaysUsed: referral.extraPlaysUsed,
      })
    }

    // Calculate base plays remaining (excluding referral and bonus plays)
    // Base plays are 1 per day since launch
    // Extra plays used (referral + bonus) should not count against base plays
    const basePlaysUsed = Math.max(0, totalPlaysUsed - safeTotalExtraPlaysUsed)
    
    // Base plays remaining = base plays allowed minus base plays used
    // This cannot go negative
    const basePlaysRemaining = Math.max(0, basePlaysAllowed - basePlaysUsed)
    
    // Total plays remaining = base plays remaining + referral plays remaining + bonus plays remaining
    const playsRemaining = basePlaysRemaining + referralExtraPlaysRemaining + bonusPlaysRemaining
    
    // Debug logging for extra play calculation
    console.log('[ExtraPlays] getPlayerStatus calculation:', {
      walletAddress: player.walletAddress,
      totalPlaysUsed,
      referralPlaysUsed,
      bonusPlaysUsed,
      safeTotalExtraPlaysUsed,
      basePlaysUsed,
      basePlaysAllowed,
      basePlaysRemaining,
      referralExtraPlaysRemaining,
      bonusPlaysRemaining,
      playsRemaining,
    })

    // Compute next available play time if user is out of plays
    let nextAvailableAt: string | null = null
    let secondsToNextPlay: number | null = null
    if (playsRemaining <= 0) {
      nextAvailableAt = nextDayStart.toISOString()
      secondsToNextPlay = Math.max(0, Math.floor((nextDayStart.getTime() - Date.now()) / 1000))
    }

    // Check if player has a valid streak (played yesterday or this is their first ever play)
    // Normalize yesterday to virtual day boundary for comparison
    // Since playDate is stored as DATE, we query a range and then normalize to check virtual day boundaries
    const normalizedYesterday = await this.normalizeToVirtualDay(yesterday, settings)
    const normalizedToday = await this.normalizeToVirtualDay(today, settings)
    
    // Query sessions in a date range that might include the virtual yesterday
    // We use a wider range to account for multiple virtual days on the same calendar date
    const dayBefore = new Date(normalizedYesterday)
    dayBefore.setDate(dayBefore.getDate() - 1)
    const dayAfter = new Date(normalizedToday)
    dayAfter.setDate(dayAfter.getDate() + 1)
    
    const recentSessions = await this.prisma.gameSession.findMany({
      where: {
        playerId: player.id,
        playDate: {
          gte: dayBefore,
          lte: dayAfter,
        },
      },
    })
    
    // Filter to only sessions that actually fall in the virtual yesterday
    // When playDate is stored, it's stored as the virtual day boundary (today), so we can compare directly
    const playedYesterday = await Promise.all(recentSessions.map(async session => {
      // playDate is stored as DATE, so we need to create a Date object and normalize it
      const sessionDate = new Date(session.playDate)
      const normalizedSessionDate = await this.normalizeToVirtualDay(sessionDate, settings)
      return normalizedSessionDate.getTime() === normalizedYesterday.getTime() ? session : null
    })).then(results => results.find(r => r !== null))

    const hasValidStreak = playedYesterday !== null || player.lastPlayDate === null

    // Use weekly scores if weekly reset is enabled, otherwise use lifetime scores
    const useWeeklyScores = settings.weeklyResetEnabled ?? false
    const displayScore = useWeeklyScores ? (player.weeklyScore ?? 0) : player.totalScore
    const storedStreak = useWeeklyScores ? (player.weeklyStreak ?? 0) : player.currentStreak
    const displayLongestStreak = useWeeklyScores ? (player.weeklyLongestStreak ?? 0) : player.longestStreak

    // Calculate what multiplier you would get if you played right now
    // This ensures the status multiplier matches what you'll actually get when you submit
    let projectedMultiplierStreak = storedStreak
    const lastPlay = player.lastPlayDate ? new Date(player.lastPlayDate) : null
    const normalizedLastPlay = lastPlay ? await this.normalizeToVirtualDay(lastPlay, settings) : null
    
    // Check if this would be your first play today
    const wouldBeFirstPlayToday = !normalizedLastPlay || normalizedLastPlay.getTime() < normalizedToday.getTime()
    
    if (wouldBeFirstPlayToday) {
      if (!normalizedLastPlay) {
        // First ever play - multiplier is base (1.0x)
        projectedMultiplierStreak = 0
      } else if (normalizedLastPlay.getTime() === normalizedYesterday.getTime()) {
        // Consecutive day - you'll get multiplier based on your current streak (day you're on)
        projectedMultiplierStreak = storedStreak // This represents "day you're on" for multiplier
      } else {
        // Gap in days - streak resets, multiplier is base (1.0x)
        projectedMultiplierStreak = 0
      }
    } else {
      // Already played today - multiplier is based on your current streak (what you have)
      projectedMultiplierStreak = storedStreak
    }

    const result: GetPlayerStatusDto = {
      walletAddress: player.walletAddress,
      totalScore: displayScore,
      lifetimeTotalScore: player.lifetimeTotalScore ?? player.totalScore, // Always include lifetime for reference
      // IMPORTANT: currentStreak now always reflects the REAL stored streak,
      // not a projected "after you play" value. This keeps the mental model
      // consistent across DB, API, and UI.
      currentStreak: storedStreak,
      longestStreak: displayLongestStreak,
      playsRemaining,
      canPlay: playsRemaining > 0,
      // Multiplier shows what you'll get if you play right now (or what you have if already played today)
      // Use isForScoreSubmission=true to match the calculation used during score submission
      streakMultiplier: this.calculateStreakMultiplier(settings, projectedMultiplierStreak, wouldBeFirstPlayToday),
      hasValidStreak,
      nextAvailableAt,
      secondsToNextPlay,
      weeklyResetEnabled: useWeeklyScores,
    }

    // Add debug info when secondsPerDay is set (testing/debugging mode)
    if (settings.secondsPerDay && settings.secondsPerDay > 0) {
      const dayMs = this.getDayDurationMs(settings)
      const virtualDayEnd = new Date(today.getTime() + dayMs - 1)
      
      // Calculate which virtual day the last play was on
      let lastPlayVirtualDay: number | null = null
      if (player.lastPlayDate) {
        const normalizedLastPlay = await this.normalizeToVirtualDay(new Date(player.lastPlayDate), settings)
        const launchMs = (await this.getGameDayInfo(settings)).launchMs
        lastPlayVirtualDay = Math.floor((normalizedLastPlay.getTime() - launchMs) / dayMs)
      }

      const debugInfo: any = {
        secondsPerDay: settings.secondsPerDay,
        virtualDay: daysSinceLaunch,
        virtualDayStart: today.toISOString(),
        virtualDayEnd: virtualDayEnd.toISOString(),
        nextVirtualDayStart: nextDayStart.toISOString(),
        basePlaysAllowed,
        basePlaysRemaining,
        referralExtraPlaysRemaining,
        totalPlaysRemaining: playsRemaining,
        totalPlaysUsed,
        lastPlayVirtualDay,
        launchDate: (settings.launchDate instanceof Date 
          ? settings.launchDate 
          : new Date(settings.launchDate)).toISOString(),
      }

      // Add week number if weekly resets are enabled
      if (settings.weeklyResetEnabled) {
        debugInfo.currentWeekNumber = await this.calculateWeekNumber(settings, today)
      }

      result.debugInfo = debugInfo
    }

      // Track metrics
      this.metricsService.playerStatusChecks.inc({
        can_play: result.canPlay ? 'true' : 'false',
      })

      return result
    } catch (error: unknown) {
      // Log unexpected errors for debugging
      console.error(`[GameService] Error getting player status for ${walletAddress}:`, error)
      
      // Convert Prisma/database errors to appropriate HTTP exceptions
      const prismaError = error as { code?: string; message?: string; status?: number }
      if (prismaError?.code?.startsWith('P')) {
        // Prisma errors
        throw new HttpException('Database error occurred', HttpStatus.INTERNAL_SERVER_ERROR)
      }
      
      // Re-throw as 500 if we don't know what it is
      throw new HttpException(
        prismaError?.message || 'Internal server error',
        prismaError?.status || HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }

  async submitScore(dto: SubmitScoreDto): Promise<GameSession> {
    try {
      const settings = await this.getSettings()
      const player = await this.findOrCreatePlayer(dto.walletAddress)
      const { today, yesterday } = await this.getGameDayInfo(settings)

      // Check if player has any plays remaining (lifetime since launch)
      const status = await this.getPlayerStatus(dto.walletAddress)
      if (!status.canPlay) {
        // Use 429 (Too Many Requests) instead of 400 - this is rate limiting, not a bad request
        throw new HttpException('No plays remaining', HttpStatus.TOO_MANY_REQUESTS)
      }

    // Check/update streak – only the first play of each day can affect streak
    // Normalize lastPlay to virtual day boundary for proper comparison
    const lastPlay = player.lastPlayDate ? new Date(player.lastPlayDate) : null
    const normalizedLastPlay = lastPlay ? await this.normalizeToVirtualDay(lastPlay, settings) : null
    const normalizedYesterday = await this.normalizeToVirtualDay(yesterday, settings)

    // Only update streak if this is the first play today
    const isFirstPlayToday = !normalizedLastPlay || normalizedLastPlay.getTime() < today.getTime()

    const isWeeklyResetEnabled = settings.weeklyResetEnabled ?? false
    
    // Get the CURRENT streak (before incrementing) for multiplier calculation
    // The multiplier should be based on the streak the player had when they played
    const currentStreak = isWeeklyResetEnabled ? (player.weeklyStreak ?? 0) : player.currentStreak
    
    // Determine what streak to use for multiplier calculation
    // If there's a gap, multiplier should be base (1.0x), not based on old stored streak
    let streakForMultiplier = currentStreak
    
    // Update streak (both lifetime and weekly if enabled)
    let newStreak = currentStreak
    let newLifetimeStreak = player.currentStreak
    
    if (isFirstPlayToday) {
      if (!normalizedLastPlay) {
        // First ever play - multiplier is base (1.0x)
        newStreak = 1
        newLifetimeStreak = 1
        streakForMultiplier = 0 // Results in base multiplier
      } else if (normalizedLastPlay.getTime() === normalizedYesterday.getTime()) {
        // Consecutive day → streak continues
        // Multiplier is based on the day you're on (current streak + 1)
        // So if you had streak 1, you're now on day 2, which should get 1.1x
        streakForMultiplier = currentStreak // This represents "day you're on" for multiplier calculation
        newStreak = currentStreak + 1
        newLifetimeStreak = player.currentStreak + 1
      } else {
        // Gap in days → streak resets
        // Multiplier should be base (1.0x) since streak is broken
        newStreak = 1
        newLifetimeStreak = 1
        streakForMultiplier = 0 // Results in base multiplier
      }

      // Update lifetime streak
      player.currentStreak = newLifetimeStreak
      if (newLifetimeStreak > player.longestStreak) {
        player.longestStreak = newLifetimeStreak
      }

      // Update weekly streak if enabled
      if (isWeeklyResetEnabled) {
        player.weeklyStreak = newStreak
        if (newStreak > (player.weeklyLongestStreak ?? 0)) {
          player.weeklyLongestStreak = newStreak
        }
      }

      // Record streak day (handle race conditions - if already exists, that's fine)
      try {
        await this.prisma.playerStreak.create({
          data: {
            playerId: player.id,
            streakDate: today,
            streakCount: newLifetimeStreak, // Always record lifetime streak
          },
        })
      } catch (error: unknown) {
        // If streak already exists for today (race condition), that's fine - continue
        const prismaError = error as { code?: string }
        if (prismaError?.code === 'P2002') {
          // Unique constraint violation - streak already recorded today
          console.log(`[GameService] Streak already recorded for player ${player.id} on ${today.toISOString()}`)
        } else {
          // Other database errors should be logged but not fail the request
          console.error(`[GameService] Error recording streak:`, error)
        }
      }
    } else {
      // Not first play today, keep existing streaks
      newStreak = currentStreak
    }

    // Calculate final score with streak multiplier.
    // - First play today: use isForScoreSubmission=true so streakForMultiplier 0=day1(1.0x), 1=day2(1.1x), etc.
    // - Subsequent same-day plays: use isForScoreSubmission=false with currentStreak so streak 1=1.0x, 2=1.1x, etc.
    //   This prevents same-day second plays from incorrectly receiving a day-2 bonus.
    const streakMultiplier = isFirstPlayToday
      ? this.calculateStreakMultiplier(settings, streakForMultiplier, true)
      : this.calculateStreakMultiplier(settings, currentStreak, false)
    const finalScore = Math.floor(dto.score * streakMultiplier)

    // Track metrics
    this.metricsService.scoresSubmitted.inc({
      has_streak_multiplier: newStreak > 1 ? 'true' : 'false',
    })
    this.metricsService.streakMultipliers.observe(
      { streak_length: newStreak.toString() },
      streakMultiplier,
    )
    
    // Update active players metric when a score is submitted (async, don't wait)
    this.updateActivePlayersMetric().catch(err => {
      console.error('[Metrics] Error updating active players after score submission:', err)
    })

    // Calculate week number for this session
    const weekNumber = settings.weeklyResetEnabled ? await this.calculateWeekNumber(settings, today) : null

    // Check if this play should use a referral play
    const referral = await this.prisma.referralCode.findUnique({
      where: { walletAddress: player.walletAddress.toLowerCase() },
    })
    const useReferralPlay = referral && referral.extraPlaysUsed < referral.extraPlaysTotal

    // Create game session
    const session = await this.prisma.gameSession.create({
      data: {
        playerId: player.id,
        score: dto.score,
        playDate: today,
        weekNumber,
        streakMultiplier,
        finalScore,
        gameData: dto.gameData,
      },
    })

    // If this was a referral play, mark it as used
    // IMPORTANT: Do this AFTER creating the session but BEFORE updating player and invalidating cache
    // This ensures the session exists when we update the referral, and the update is committed
    // before any subsequent getPlayerStatus calls
    if (useReferralPlay) {
      console.log('[Referral] Marking referral play as used:', {
        walletAddress: player.walletAddress,
        before: referral.extraPlaysUsed,
        after: referral.extraPlaysUsed + 1,
        total: referral.extraPlaysTotal,
      })
      await this.prisma.referralCode.update({
        where: { walletAddress: player.walletAddress.toLowerCase() },
        data: {
          extraPlaysUsed: referral.extraPlaysUsed + 1,
        },
      })
      console.log('[Referral] Referral play marked as used successfully')
    } else {
      // No referral play used - check if this was a bonus play
      const usedBonusPlay = await this.bonusService.markBonusPlayUsed(player.walletAddress.toLowerCase())
      if (usedBonusPlay) {
        console.log('[Bonus] Bonus play marked as used for:', player.walletAddress)
      }
    }

    // Update player totals
    player.totalScore += finalScore
    player.lastPlayDate = today
    
    const updateData: any = {
      totalScore: player.totalScore,
      currentStreak: player.currentStreak,
      longestStreak: player.longestStreak,
      lastPlayDate: player.lastPlayDate,
    }
    
    // Update weekly scores if enabled
    if (isWeeklyResetEnabled) {
      updateData.weeklyScore = (player.weeklyScore ?? 0) + finalScore
      updateData.weeklyStreak = player.weeklyStreak ?? 0
      updateData.weeklyLongestStreak = player.weeklyLongestStreak ?? 0
    }
    
    await this.prisma.player.update({
      where: { id: player.id },
      data: updateData,
    })

    // Invalidate caches
    await this.cacheManager.del(`player:${dto.walletAddress}`)
    
    // Invalidate all leaderboard caches (both weekly and lifetime)
    // Since we can't easily pattern-match delete with cache-manager, we'll use Redis directly
    try {
      const store = (this.cacheManager as Cache & { store?: Store & { mdel?: (...keys: string[]) => Promise<void> } }).store
      if (store && 'keys' in store && 'mdel' in store && typeof store.keys === 'function' && typeof store.mdel === 'function') {
        // Get all leaderboard cache keys
        const leaderboardKeys = await store.keys('leaderboard:*')
        if (leaderboardKeys && leaderboardKeys.length > 0) {
          await store.mdel(...leaderboardKeys)
          console.log(`[Cache] Invalidated ${leaderboardKeys.length} leaderboard cache keys`)
        }
      }
    } catch (cacheError) {
      console.log(`[Cache] Error invalidating leaderboard cache:`, cacheError)
      // Continue - cache invalidation failure shouldn't break score submission
    }

    return session
    } catch (error: unknown) {
      // If it's already an HttpException (like 429), re-throw it
      if (error instanceof HttpException) {
        throw error
      }
      
      // Log unexpected errors for debugging
      console.error(`[GameService] Error submitting score for ${dto.walletAddress}:`, error)
      
      // Convert Prisma/database errors to appropriate HTTP exceptions
      const prismaError = error as { code?: string; message?: string; status?: number }
      if (prismaError?.code === 'P2002') {
        // Unique constraint violation - could be race condition
        throw new HttpException('Score submission conflict - please try again', HttpStatus.CONFLICT)
      } else if (prismaError?.code?.startsWith('P')) {
        // Other Prisma errors
        throw new HttpException('Database error occurred', HttpStatus.INTERNAL_SERVER_ERROR)
      }
      
      // Re-throw as 500 if we don't know what it is
      throw new HttpException(
        prismaError?.message || 'Internal server error',
        prismaError?.status || HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }

  async getLeaderboard(limit = 10, page = 1, userWalletAddress?: string) {
    const settings = await this.getSettings()
    const useWeeklyScores = settings.weeklyResetEnabled ?? false
    const mode = useWeeklyScores ? 'weekly' : 'lifetime'
    
    // Build cache keys
    const pageCacheKey = `leaderboard:${mode}:page:${page}:limit:${limit}`
    const userCacheKey = userWalletAddress ? `leaderboard:${mode}:user:${userWalletAddress}` : null
    
    // Try to get from cache first
    let cacheHit = false
    try {
      const cacheOpStart = Date.now()
      const cachedPage = await this.cacheManager.get<any>(pageCacheKey)
      const cachedUser = userCacheKey ? await this.cacheManager.get<any>(userCacheKey) : null
      const cacheOpDuration = (Date.now() - cacheOpStart) / 1000
      
      this.metricsService.cacheOperations.observe(
        { operation: 'get', cache_key_pattern: 'leaderboard:*' },
        cacheOpDuration,
      )
      
      if (cachedPage && (!userWalletAddress || cachedUser)) {
        // Cache hit - return from Redis (no DB query needed!)
        console.log(`[Cache] ✅ Leaderboard cache HIT: ${pageCacheKey}`)
        this.metricsService.cacheHits.inc({ cache_key_pattern: 'leaderboard:*' })
        this.metricsService.leaderboardViews.inc({ mode })
        cacheHit = true
        return {
          ...cachedPage,
          userRank: cachedUser?.userRank ?? cachedPage.userRank,
          userEntry: cachedUser?.userEntry ?? cachedPage.userEntry,
        }
      } else {
        console.log(`[Cache] ❌ Leaderboard cache MISS: ${pageCacheKey} - fetching from DB`)
        this.metricsService.cacheMisses.inc({ cache_key_pattern: 'leaderboard:*' })
      }
    } catch (cacheError) {
      console.log(`[Cache] Error reading leaderboard cache:`, cacheError)
      this.metricsService.redisErrors.inc({ error_type: 'cache_read_error' })
      // Continue to fetch from database
    }
    
    const orderByField = useWeeklyScores ? 'weeklyScore' : 'totalScore'
    
    // Get total count
    const totalCount = await this.prisma.player.count()
    
    // Calculate pagination
    const skip = (page - 1) * limit
    
    // Get players for current page
    // Order by score descending, then by ID ascending for consistent ordering when scores are equal
    const players = await this.prisma.player.findMany({
      orderBy: [
        { [orderByField]: 'desc' },
        { id: 'asc' }, // Secondary sort for consistent ordering when scores are equal
      ],
      skip,
      take: limit,
    })

    // Find user's rank if wallet address provided
    let userRank: number | null = null
    let userEntry: any = null
    if (userWalletAddress) {
      // Count players with higher score
      const user = await this.prisma.player.findUnique({
        where: { walletAddress: userWalletAddress },
      })
      
      if (user) {
        const userScore = useWeeklyScores ? (user.weeklyScore ?? 0) : user.totalScore
        const userId = user.id
        
        // Count players with strictly higher scores OR same score but lower ID (earlier creation)
        // This ensures consistent ranking when scores are equal
        const playersAbove = await this.prisma.player.count({
          where: {
            OR: [
              {
                [orderByField]: {
                  gt: userScore,
                },
              },
              {
                AND: [
                  { [orderByField]: userScore },
                  { id: { lt: userId } }, // Players with same score but created earlier (lower ID)
                ],
              },
            ],
          },
        })
        userRank = playersAbove + 1
        
        // Get user's entry with surrounding context
        const userStreak = useWeeklyScores ? (user.weeklyStreak ?? 0) : user.currentStreak
        const userLongestStreak = useWeeklyScores ? (user.weeklyLongestStreak ?? 0) : user.longestStreak
        
        userEntry = {
          rank: userRank,
          walletAddress: user.walletAddress,
          totalScore: userScore,
          currentStreak: userStreak,
          longestStreak: userLongestStreak,
          streakMultiplier: this.calculateStreakMultiplier(settings, userStreak),
        }
      }
    }

    const leaderboard = players.map((p, index) => {
      const score = useWeeklyScores ? (p.weeklyScore ?? 0) : p.totalScore
      const streak = useWeeklyScores ? (p.weeklyStreak ?? 0) : p.currentStreak
      const longestStreak = useWeeklyScores ? (p.weeklyLongestStreak ?? 0) : p.longestStreak
      
      return {
        rank: skip + index + 1,
        walletAddress: p.walletAddress,
        totalScore: score,
        currentStreak: streak,
        longestStreak: longestStreak,
        streakMultiplier: this.calculateStreakMultiplier(settings, streak),
      }
    })

    // Calculate next reset time if weekly resets are enabled
    let nextResetTime: string | null = null
    if (useWeeklyScores) {
      nextResetTime = (await this.calculateNextResetTime(settings)).toISOString()
    }

    const result = {
      entries: leaderboard,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
      userRank,
      userEntry,
      nextResetTime,
      weeklyResetEnabled: useWeeklyScores,
    }
    
    // Cache the results (after fetching from DB)
    try {
      const ttlMs = 30 * 1000 // 30 seconds TTL for leaderboard
      const cacheSetStart = Date.now()
      
      // Cache the page result
      await this.cacheManager.set(pageCacheKey, {
        entries: result.entries,
        pagination: result.pagination,
        nextResetTime: result.nextResetTime,
        weeklyResetEnabled: result.weeklyResetEnabled,
        // Don't cache userRank/userEntry in page cache - cache separately
      }, ttlMs)
      const cacheSetDuration = (Date.now() - cacheSetStart) / 1000
      this.metricsService.cacheOperations.observe(
        { operation: 'set', cache_key_pattern: 'leaderboard:*' },
        cacheSetDuration,
      )
      console.log(`[Cache] ✅ Cached leaderboard page: ${pageCacheKey} (TTL: 30s)`)
      
      // Cache user-specific data separately if provided
      if (userCacheKey && userWalletAddress) {
        await this.cacheManager.set(userCacheKey, {
          userRank: result.userRank,
          userEntry: result.userEntry,
        }, ttlMs)
        console.log(`[Cache] ✅ Cached user leaderboard data: ${userCacheKey} (TTL: 30s)`)
      }
    } catch (cacheError) {
      console.log(`[Cache] Error caching leaderboard:`, cacheError)
      this.metricsService.redisErrors.inc({ error_type: 'cache_write_error' })
      // Continue - caching failure shouldn't break the request
    }
    
    // Track leaderboard view (only for cache misses, cache hits already tracked above)
    if (!cacheHit) {
      this.metricsService.leaderboardViews.inc({ mode })
    }
    
    return result
  }

  async getPlayerHistory(walletAddress: string, limit = 50): Promise<GameSession[]> {
    const player = await this.prisma.player.findUnique({
      where: { walletAddress },
    })

    if (!player) {
      throw new NotFoundException('Player not found')
    }

    return this.prisma.gameSession.findMany({
      where: { playerId: player.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
  }

  private async findOrCreatePlayer(walletAddress: string): Promise<Player> {
    const cacheKey = `player:${walletAddress}`
    const cacheStart = Date.now()
    const cached = await this.cacheManager.get<Player>(cacheKey)
    const cacheDuration = (Date.now() - cacheStart) / 1000
    
    this.metricsService.cacheOperations.observe(
      { operation: 'get', cache_key_pattern: 'player:*' },
      cacheDuration,
    )
    
    if (cached) {
      this.metricsService.cacheHits.inc({ cache_key_pattern: 'player:*' })
      return cached
    }
    
    this.metricsService.cacheMisses.inc({ cache_key_pattern: 'player:*' })

    let player = await this.prisma.player.findUnique({
      where: { walletAddress },
    })

    if (!player) {
      const settings = await this.getSettings()
      player = await this.prisma.player.create({
        data: {
          walletAddress,
          launchDate: settings.launchDate,
          totalScore: 0,
          currentStreak: 0,
          longestStreak: 0,
          lifetimeTotalScore: 0,
          weeklyScore: 0,
          weeklyStreak: 0,
          weeklyLongestStreak: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      })
    }

    const cacheSetStart = Date.now()
    await this.cacheManager.set(cacheKey, player, 3600 * 1000) // Cache for 1 hour (3600000ms)
    const cacheSetDuration = (Date.now() - cacheSetStart) / 1000
    this.metricsService.cacheOperations.observe(
      { operation: 'set', cache_key_pattern: 'player:*' },
      cacheSetDuration,
    )
    return player
  }

  /**
   * Invalidate all player:* cache entries. Must be called after weekly reset so that
   * the next findOrCreatePlayer loads fresh DB data (e.g. weeklyScore = 0) instead of
   * stale cached values that would cause submitted scores to be added on top of old totals.
   */
  async invalidateAllPlayerCaches(): Promise<void> {
    try {
      const store = (this.cacheManager as Cache & { store?: Store & { keys?: (pattern: string) => Promise<string[]>; mdel?: (...keys: string[]) => Promise<void> } }).store
      if (store && 'keys' in store && 'mdel' in store && typeof store.keys === 'function' && typeof store.mdel === 'function') {
        const playerKeys = await store.keys('player:*')
        if (playerKeys && playerKeys.length > 0) {
          await store.mdel(...playerKeys)
          console.log(`[Cache] Invalidated ${playerKeys.length} player cache keys after weekly reset`)
        }
      }
    } catch (err) {
      console.error('[Cache] Error invalidating player caches after weekly reset:', err)
      // Non-fatal; next read will miss cache and hit DB
    }
  }

  private calculateStreakMultiplier(settings: GameSettings, streak: number, isForScoreSubmission = false): number {
    // Multiplier rules:
    // During score submission: streak represents "day you're on"
    //   - Day 1 (streak = 0) → 1.0x
    //   - Day 2 (streak = 1) → 1.1x
    //   - Day 3 (streak = 2) → 1.2x, etc.
    // For leaderboard/status: streak represents "days completed"
    //   - Streak 0 = never played → 1.0x
    //   - Streak 1 = completed 1 day → 1.0x (still on first day)
    //   - Streak 2 = completed 2 days → 1.1x (on second day)
    //   - Streak 3 = completed 3 days → 1.2x, etc.
    // - Hard cap at 2.0x to avoid unbounded growth
    
    if (isForScoreSubmission) {
      // During submission: streak 0 = day 1, streak 1 = day 2, etc.
      if (streak <= 0) {
        return settings.streakBaseMultiplier
      }
      const raw = settings.streakBaseMultiplier + streak * settings.streakIncrementPerDay
      return Math.min(raw, 2.0)
    } else {
      // For display: streak 1 = completed 1 day (still day 1), streak 2 = completed 2 days (day 2), etc.
      if (streak <= 1) {
        return settings.streakBaseMultiplier
      }
      const raw = settings.streakBaseMultiplier + (streak - 1) * settings.streakIncrementPerDay
      return Math.min(raw, 2.0)
    }
  }

  /**
   * Calculate the next reset time based on weekly reset settings.
   * Returns the date/time when the next weekly reset will occur.
   * Uses WordPress timezone for production mode (same as livestream system).
   */
  private async calculateNextResetTime(settings: GameSettings): Promise<Date> {
    const now = new Date(Date.now())
    const resetDay = settings.weeklyResetDay ?? 0 // 0 = Sunday, 1 = Monday, etc.
    const resetHour = settings.weeklyResetHour ?? 1 // Default to 1 AM
    const resetMinute = settings.weeklyResetMinute ?? 0
    
    if (settings.secondsPerDay && settings.secondsPerDay > 0) {
      // Debug mode: Use virtual weeks (keep UTC-based for simplicity)
      const dayMs = this.getDayDurationMs(settings)
      const launchDate = new Date(settings.launchDate)
      launchDate.setUTCHours(0, 0, 0, 0)
      const launchMs = launchDate.getTime()
      
      const daysSinceLaunch = Math.floor((now.getTime() - launchMs) / dayMs)
      const currentWeek = Math.floor(daysSinceLaunch / 7)
      const nextWeekStart = launchMs + (currentWeek + 1) * 7 * dayMs
      
      return new Date(nextWeekStart)
    } else {
      // Production mode: Use real calendar weeks with timezone-aware calculations
      const wpTimezone = await this.timezoneService.getWordPressTimezone()
      
      // Get current date/time in WordPress timezone
      const nowZoned = toZonedTime(now, wpTimezone)
      const currentDay = nowZoned.getDay() // 0 = Sunday, 1 = Monday, etc.
      const currentHour = nowZoned.getHours()
      const currentMinute = nowZoned.getMinutes()
      
      let daysUntilReset = (resetDay - currentDay + 7) % 7
      
      // If it's the reset day, check if we're before or after reset time
      if (daysUntilReset === 0) {
        const resetTimeMinutes = resetHour * 60 + resetMinute
        const currentTimeMinutes = currentHour * 60 + currentMinute
        
        if (currentTimeMinutes >= resetTimeMinutes) {
          // Already past reset time today, next reset is next week
          daysUntilReset = 7
        } else {
          // Reset is today but hasn't happened yet
          daysUntilReset = 0
        }
      }
      
      // Calculate next reset date in WordPress timezone
      const nextResetTzDate = new Date(nowZoned)
      nextResetTzDate.setDate(nowZoned.getDate() + daysUntilReset)
      nextResetTzDate.setHours(resetHour, resetMinute, 0, 0)
      
      // Convert from WordPress timezone to UTC
      const nextReset = fromZonedTime(nextResetTzDate, wpTimezone)
      
      return nextReset
    }
  }

  /**
   * Calculate the week number for a given date.
   * Week 0 is the first week (launch week).
   * In debug mode, uses virtual weeks based on secondsPerDay.
   * Uses WordPress timezone for production mode (same as livestream system).
   */
  private async calculateWeekNumber(settings: GameSettings, date: Date): Promise<number> {
    if (settings.secondsPerDay && settings.secondsPerDay > 0) {
      // Debug mode: Use virtual weeks (UTC-based)
      const launchDate = new Date(settings.launchDate)
      launchDate.setUTCHours(0, 0, 0, 0)
      const dayMs = this.getDayDurationMs(settings)
      const launchMs = launchDate.getTime()
      const daysSinceLaunch = Math.floor((date.getTime() - launchMs) / dayMs)
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
      
      const dateTz = await this.timezoneService.getStartOfDayInTimezone(date)
      if (!dateTz) {
        throw new Error('Failed to parse date')
      }
      
      // Convert to zoned time to get day of week in WordPress timezone
      const launchZoned = toZonedTime(launchDateTz, wpTimezone)
      const dateZoned = toZonedTime(dateTz, wpTimezone)
      
      const launchDay = launchZoned.getDay()
      const currentDay = dateZoned.getDay()
      const currentHour = dateZoned.getHours()
      const currentMinute = dateZoned.getMinutes()
      
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
      
      const weekStartDate = new Date(dateZoned)
      weekStartDate.setDate(dateZoned.getDate() - daysToSubtract)
      weekStartDate.setHours(0, 0, 0, 0)
      const weekStart = fromZonedTime(weekStartDate, wpTimezone)
      
      // Calculate week number
      const weekMs = 7 * 24 * 60 * 60 * 1000
      const weeksSinceLaunch = Math.floor((weekStart.getTime() - launchWeekStart.getTime()) / weekMs)
      
      return Math.max(0, weeksSinceLaunch)
    }
  }

  /**
   * Load game settings from WordPress (single source of truth).
   * Merges WordPress settings with DB-only fields (streak multipliers, etc.).
   * Settings are cached for 60 seconds to allow quick testing of changes.
   */
  async getSettings(): Promise<GameSettings> {
    const cacheKey = 'game:settings'
    const fallbackKey = 'game:settings:fallback'

    // --- Primary cache (60s TTL) ---
    try {
      const cacheStart = Date.now()
      const cached = await this.cacheManager.get<GameSettings>(cacheKey)
      this.metricsService.cacheOperations.observe(
        { operation: 'get', cache_key_pattern: 'game:settings' },
        (Date.now() - cacheStart) / 1000,
      )

      if (cached) {
        this.metricsService.cacheHits.inc({ cache_key_pattern: 'game:settings' })
        return cached
      }
      this.metricsService.cacheMisses.inc({ cache_key_pattern: 'game:settings' })
    } catch (error) {
      console.error(`[Cache] Error accessing cache:`, error)
      this.metricsService.redisErrors.inc({ error_type: 'cache_read_error' })
    }

    // --- Thundering herd protection ---
    // If another request is already fetching from WordPress, piggyback on it
    // instead of firing another concurrent request. This collapses N simultaneous
    // cache-miss requests into a single WordPress call.
    if (this.settingsFetchInProgress) {
      console.log('[getSettings] In-flight fetch detected — awaiting existing WordPress request')
      return this.settingsFetchInProgress
    }

    console.log('[getSettings] Cache miss — fetching from WordPress...')
    this.settingsFetchInProgress = this.fetchAndCacheSettings(cacheKey, fallbackKey).finally(() => {
      this.settingsFetchInProgress = null
    })

    return this.settingsFetchInProgress
  }

  /**
   * Internal: fetches from WordPress, merges with DB settings, and writes both caches.
   * Only ever called by one concurrent request at a time (thundering herd protection).
   */
  private async fetchAndCacheSettings(cacheKey: string, fallbackKey: string): Promise<GameSettings> {
    let wpSettings = await this.wordpressService.getGameSettings()

    if (!wpSettings || !wpSettings.launchDate) {
      // WordPress unavailable — try stale fallback (24h TTL) before throwing
      try {
        const stale = await this.cacheManager.get<GameSettings>(fallbackKey)
        if (stale) {
          console.warn('[getSettings] ⚠️ WordPress unavailable — serving stale settings from fallback cache')
          return stale
        }
      } catch (fallbackError) {
        console.error('[getSettings] Error reading fallback cache:', fallbackError)
      }
      throw new Error('WordPress game settings are required and no fallback is available. Please configure game_launch_date in WordPress ACF.')
    }

    // --- Get / initialise DB-only fields ---
    let dbSettings = await this.prisma.gameSettings.findUnique({ where: { id: 1 } })
    if (!dbSettings) {
      dbSettings = await this.prisma.gameSettings.create({
        data: {
          id: 1,
          streakBaseMultiplier: 1.0,
          streakIncrementPerDay: 0.1,
          secondsPerDay: null,
          currentWeekNumber: null,
          referralExtraPlays: 3,
        },
      })
      console.log(`✅ GameSettings DB row initialized`)
    }

    const mergedSettings = mergeGameSettings(wpSettings, dbSettings)

    console.log(`[getSettings] ✅ Merged settings:`, {
      launchDate: mergedSettings.launchDate?.toISOString(),
      gameState: mergedSettings.gameState,
      weeklyResetEnabled: mergedSettings.weeklyResetEnabled,
      streakBaseMultiplier: mergedSettings.streakBaseMultiplier,
      referralExtraPlays: mergedSettings.referralExtraPlays,
    })

    // --- Write to primary cache (5min) + fallback cache (24h) ---
    try {
      const ttlMs = 5 * 60 * 1000 // 5 minutes — settings rarely change during operation
      const cacheSetStart = Date.now()
      await this.cacheManager.set(cacheKey, mergedSettings, ttlMs)
      this.metricsService.cacheOperations.observe(
        { operation: 'set', cache_key_pattern: 'game:settings' },
        (Date.now() - cacheSetStart) / 1000,
      )
      console.log(`[Cache] ✅ Stored settings (5min TTL)`)

      // Stale fallback: 24 hours — survives WordPress outages / pod restarts
      await this.cacheManager.set(fallbackKey, mergedSettings, 24 * 60 * 60 * 1000)
      console.log(`[Cache] ✅ Stored settings fallback (24h TTL)`)
    } catch (error: unknown) {
      const err = error as Error
      console.error(`[Cache] ❌ CRITICAL: Error storing in cache:`, err.message)
      throw new Error(`Cache write failed: ${err.message}. Cannot proceed without Redis cache.`)
    }

    return mergedSettings
  }

  /**
   * Get game state information for frontend.
   * Returns a graceful degraded response if WordPress is temporarily unavailable
   * and the stale fallback cache is also empty.
   */
  async getGameState(): Promise<{ gameState: string; launchDate: string; isLaunched: boolean }> {
    try {
      const settings = await this.getSettings()
      const now = new Date()
      return {
        gameState: settings.gameState,
        launchDate: settings.launchDate.toISOString(),
        isLaunched: now >= settings.launchDate,
      }
    } catch (error: unknown) {
      // getSettings() already attempted the 24h stale fallback — if we're here,
      // both WordPress and the fallback cache are unavailable.
      // Return a safe degraded response rather than crashing with 500.
      console.error('[GameService] getGameState failed — returning degraded response:', error)
      return {
        gameState: 'ACTIVE',
        launchDate: new Date(0).toISOString(),
        isLaunched: true,
      }
    }
  }

  /**
   * Clear the settings cache (useful for testing/debugging)
   */
  async clearSettingsCache(): Promise<void> {
    await this.cacheManager.del('game:settings')
  }

  /**
   * Initialize GameSettings on module startup.
   * This ensures settings exist before any game operations.
   */
  async onModuleInit() {
    try {
      await this.getSettings()
      console.log('✅ GameSettings initialized')
      // Update active players metric on startup
      await this.updateActivePlayersMetric()
    } catch (error) {
      console.error('❌ Failed to initialize GameSettings:', error)
      // Don't throw - let the app start, but log the error
    }
  }

  /**
   * Update the active players metric (players who played in last 24 hours)
   * Runs every 5 minutes to keep the metric current
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async updateActivePlayersMetric() {
    try {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
      
      // Count distinct players who have played in the last 24 hours
      // Use createdAt (actual session creation time) instead of playDate (which is set to start of day)
      const activePlayerCount = await this.prisma.gameSession.groupBy({
        by: ['playerId'],
        where: {
          createdAt: {
            gte: twentyFourHoursAgo,
          },
        },
        _count: {
          playerId: true,
        },
      })

      const count = activePlayerCount.length
      this.metricsService.activePlayers.set(count)
      console.log(`[Metrics] Updated active players: ${count}`)
    } catch (error) {
      console.error('[Metrics] Error updating active players metric:', error)
      // Don't throw - metric update failure shouldn't break the app
    }
  }
}
