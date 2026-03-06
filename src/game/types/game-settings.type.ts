import { GameSettingsFromWordPress } from '../../wordpress/wordpress.service'
import { PrismaClient } from '@prisma/client'

/**
 * Database-only fields (not in WordPress)
 */
type GameSettingsDB = Awaited<ReturnType<PrismaClient['gameSettings']['findUnique']>>

/**
 * Complete game settings type combining WordPress (source of truth) + DB-only fields
 * WordPress fields take precedence and are the single source of truth
 */
export type GameSettings = GameSettingsFromWordPress & {
  // DB-only fields
  id: number
  streakBaseMultiplier: number
  streakIncrementPerDay: number
  secondsPerDay: number | null
  currentWeekNumber: number | null
  referralExtraPlays: number
  createdAt: Date
  updatedAt: Date
}

/**
 * Helper to merge WordPress settings with DB settings
 * WordPress is the single source of truth for launchDate, gameState, and weeklyReset* fields
 */
export function mergeGameSettings(
  wpSettings: GameSettingsFromWordPress | null,
  dbSettings: GameSettingsDB | null,
): GameSettings {
  if (!wpSettings || !wpSettings.launchDate || !wpSettings.gameState) {
    throw new Error('WordPress settings are required - they are the single source of truth. Please configure game_launch_date and game_state in WordPress ACF.')
  }

  // Ensure all WordPress fields have defaults if null
  const launchDate = wpSettings.launchDate
  const gameState = wpSettings.gameState
  const weeklyResetEnabled = wpSettings.weeklyResetEnabled ?? false
  const weeklyResetDay = wpSettings.weeklyResetDay ?? 0
  const weeklyResetHour = wpSettings.weeklyResetHour ?? 1
  const weeklyResetMinute = wpSettings.weeklyResetMinute ?? 0
  const dailyCheckInEnabled = wpSettings.dailyCheckInEnabled ?? false
  const dailyCheckInLaunchDate = wpSettings.dailyCheckInLaunchDate ?? null

  if (!dbSettings) {
    // Return WordPress settings with DB defaults
    return {
      launchDate,
      gameState,
      weeklyResetEnabled,
      weeklyResetDay,
      weeklyResetHour,
      weeklyResetMinute,
      dailyCheckInEnabled,
      dailyCheckInLaunchDate,
      id: 1,
      streakBaseMultiplier: 1.0,
      streakIncrementPerDay: 0.1,
      secondsPerDay: null,
      currentWeekNumber: null,
      referralExtraPlays: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
  }

  // Merge: WordPress (source of truth) + DB-only fields
  return {
    launchDate,
    gameState,
    weeklyResetEnabled,
    weeklyResetDay,
    weeklyResetHour,
    weeklyResetMinute,
    dailyCheckInEnabled,
    dailyCheckInLaunchDate,
    id: dbSettings.id,
    streakBaseMultiplier: dbSettings.streakBaseMultiplier,
    streakIncrementPerDay: dbSettings.streakIncrementPerDay,
    secondsPerDay: dbSettings.secondsPerDay,
    currentWeekNumber: dbSettings.currentWeekNumber,
    referralExtraPlays: dbSettings.referralExtraPlays,
    createdAt: dbSettings.createdAt,
    updatedAt: dbSettings.updatedAt,
  }
}

/**
 * Helper function to create a complete GameSettings object for testing
 * Includes all required WordPress fields with sensible defaults
 */
export function createTestGameSettings(overrides?: Partial<GameSettings>): GameSettings {
  const launchDate = overrides?.launchDate || new Date('2025-01-01T00:00:00.000Z')
  return {
    launchDate,
    gameState: 'ACTIVE',
    weeklyResetEnabled: false,
    weeklyResetDay: 0,
    weeklyResetHour: 1,
    weeklyResetMinute: 0,
    dailyCheckInEnabled: false,
    dailyCheckInLaunchDate: null,
    id: 1,
    streakBaseMultiplier: 1.0,
    streakIncrementPerDay: 0.1,
    secondsPerDay: null,
    currentWeekNumber: null,
    referralExtraPlays: 3,
    createdAt: launchDate,
    updatedAt: launchDate,
    ...overrides,
  }
}
