import { Test, TestingModule } from '@nestjs/testing'
import { ConfigService } from '@nestjs/config'
import { WeeklyResetService } from './weekly-reset.service'
import { GameService } from './game.service'
import { PrismaService, PrismaClient } from '../prisma/prisma.service'
import { CACHE_MANAGER } from '@nestjs/cache-manager'
import { Cache } from 'cache-manager'
import { GameSettings, createTestGameSettings } from './types/game-settings.type'

type Player = Awaited<ReturnType<PrismaClient['player']['findUnique']>>

describe('WeeklyResetService', () => {
  let service: WeeklyResetService
  let gameService: GameService
  let prisma: PrismaService
  let prismaClient: PrismaClient
  let cache: Cache

  const launchDate = new Date('2025-01-01T00:00:00.000Z')

  beforeEach(async () => {
    // Clear all mocks before each test
    jest.clearAllMocks()
    jest.restoreAllMocks()
    jest.useRealTimers() // Reset to real timers first

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeeklyResetService,
        GameService,
        {
          provide: PrismaService,
          useValue: {
            gameSettings: {
              findUnique: jest.fn(),
              upsert: jest.fn(),
              update: jest.fn(),
            },
            player: {
              findUnique: jest.fn(),
              findMany: jest.fn(),
              update: jest.fn(),
            },
          },
        },
        {
          provide: CACHE_MANAGER,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('postgresql://test:test@localhost:5432/test'),
          },
        },
      ],
    }).compile()

    service = module.get<WeeklyResetService>(WeeklyResetService)
    gameService = module.get<GameService>(GameService)
    prisma = module.get<PrismaService>(PrismaService)
    prismaClient = prisma as PrismaClient
    cache = module.get<Cache>(CACHE_MANAGER)
  })

  afterEach(() => {
    // Restore all mocks and timers after each test
    jest.restoreAllMocks()
    jest.useRealTimers()
    // Restore Date.now if it was mocked
    Object.defineProperty(Date, 'now', {
      writable: true,
      configurable: true,
      value: Date.now,
    })
  })

  describe('Weekly Reset - Basic Functionality', () => {
    it('should not perform reset when weekly reset is disabled', async () => {
      const settings = createTestGameSettings({
        launchDate,
      })

      jest.spyOn(gameService, 'getSettings').mockResolvedValue(settings)
      jest.spyOn(prismaClient.gameSettings, 'update').mockResolvedValue(settings)
      jest.spyOn(prismaClient.player, 'findMany').mockResolvedValue([])

      await service.checkAndPerformReset()

      expect(prismaClient.player.findMany).not.toHaveBeenCalled()
      expect(prismaClient.gameSettings.update).not.toHaveBeenCalled()
    })

    it('should perform reset when week number increases', async () => {
      const settings = createTestGameSettings({
        launchDate,
        secondsPerDay: 60, // 1 minute = 1 day
        weeklyResetEnabled: true,
        weeklyResetDay: 0,
        currentWeekNumber: 0, // Week 0
      })

      const player1: Player = {
        id: 1,
        walletAddress: '0xPLAYER1',
        launchDate,
        totalScore: 0,
        currentStreak: 5,
        longestStreak: 5,
        lastPlayDate: new Date(launchDate.getTime() + 5 * 60 * 1000),
        createdAt: launchDate,
        updatedAt: launchDate,
        lifetimeTotalScore: 1000,
        weeklyScore: 5000,
        weeklyStreak: 5,
        weeklyLongestStreak: 5,
        lastResetWeekNumber: 0,
      })

      const player2: Player = {
        id: 2,
        walletAddress: '0xPLAYER2',
        launchDate,
        totalScore: 0,
        currentStreak: 3,
        longestStreak: 3,
        lastPlayDate: new Date(launchDate.getTime() + 3 * 60 * 1000),
        createdAt: launchDate,
        updatedAt: launchDate,
        lifetimeTotalScore: 500,
        weeklyScore: 3000,
        weeklyStreak: 3,
        weeklyLongestStreak: 3,
        lastResetWeekNumber: null, // Never reset
      })

      // Mock current time: 8 days after launch (Week 1)  
      const now = new Date(launchDate.getTime() + 8 * 60 * 1000)
      const nowMs = now.getTime()
      
      // Mock Date.now() for this test
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(nowMs)
      
      // Mock getSettings AFTER Date.now() is mocked
      const settingsWithWeek = createTestGameSettings({
        launchDate,
        secondsPerDay: 60,
        weeklyResetEnabled: true,
        weeklyResetDay: 0,
        currentWeekNumber: 1,
      })
      jest.spyOn(gameService, 'getSettings').mockResolvedValue(settingsWithWeek)
      jest.spyOn(prismaClient.gameSettings, 'update').mockResolvedValue({
        id: 1,
        streakBaseMultiplier: 1.0,
        streakIncrementPerDay: 0.1,
        secondsPerDay: 60,
        currentWeekNumber: 1,
        referralExtraPlays: 3,
        createdAt: launchDate,
        updatedAt: launchDate,
      })
      jest.spyOn(prismaClient.player, 'findMany').mockResolvedValue([player1, player2])
      jest.spyOn(prismaClient.player, 'update').mockResolvedValue(player1)

      await service.checkAndPerformReset()
      
      // Should update settings with new week number
      expect(prismaClient.gameSettings.update).toHaveBeenCalled()
      
      // Verify Date.now was called
      expect(dateNowSpy).toHaveBeenCalled()
      
      // Should update settings with new week number
      expect(prismaClient.gameSettings.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { currentWeekNumber: 1 },
      })
      
      dateNowSpy.mockRestore()

      // Should find players that need reset
      expect(prismaClient.player.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { lastResetWeekNumber: null },
            { lastResetWeekNumber: { lt: 1 } },
          ],
        },
      })

      // Should reset both players
      expect(prismaClient.player.update).toHaveBeenCalledTimes(2)

      // Check player1 reset
      expect(prismaClient.player.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          lifetimeTotalScore: 6000, // 1000 + 5000
          weeklyScore: 0,
          lastResetWeekNumber: 1,
        },
      })

      // Check player2 reset
      expect(prismaClient.player.update).toHaveBeenCalledWith({
        where: { id: 2 },
        data: {
          lifetimeTotalScore: 3500, // 500 + 3000
          weeklyScore: 0,
          lastResetWeekNumber: 1,
        },
      })
    })

    it('should not reset players already reset in current week', async () => {
      const settings = createTestGameSettings({
        launchDate,
        secondsPerDay: 60,
        weeklyResetEnabled: true,
        weeklyResetDay: 0,
        currentWeekNumber: 1,
      })

      const player: Player = {

        id: 1,
        walletAddress: '0xPLAYER1',
        launchDate,
        totalScore: 0,
        currentStreak: 2,
        longestStreak: 2,
        lastPlayDate: new Date(launchDate.getTime() + 8 * 60 * 1000),


        lifetimeTotalScore: 5000,
        weeklyScore: 1000,
        weeklyStreak: 2,
        weeklyLongestStreak: 2,
        lastResetWeekNumber: 1, // Already reset in week 1
        createdAt: launchDate,
        updatedAt: launchDate,
      })

      const now = new Date(launchDate.getTime() + 8 * 60 * 1000) // Still week 1
      const originalDateNow = Date.now
      Date.now = jest.fn(() => now.getTime())

      jest.spyOn(gameService, 'getSettings').mockResolvedValue(settings)
      jest.spyOn(prismaClient.gameSettings, 'update').mockResolvedValue(settings)
      jest.spyOn(prismaClient.player, 'findMany').mockResolvedValue([]) // No players need reset
      jest.spyOn(prismaClient.player, 'update').mockResolvedValue(player)

      await service.checkAndPerformReset()

      // Should not update any players
      expect(prismaClient.player.update).not.toHaveBeenCalled()
    })

    it('should preserve lifetime score when resetting weekly score', async () => {
      const settings = createTestGameSettings({
        launchDate,
        secondsPerDay: 60,
        weeklyResetEnabled: true,
        weeklyResetDay: 0,
        currentWeekNumber: 0,
      })

      const player: Player = {

        id: 1,
        walletAddress: '0xPLAYER1',
        launchDate,
        totalScore: 0,
        currentStreak: 5,
        longestStreak: 5,
        lastPlayDate: launchDate,


        lifetimeTotalScore: 2000, // Existing lifetime score
        weeklyScore: 8000, // Current weekly score
        weeklyStreak: 5,
        weeklyLongestStreak: 5,
        lastResetWeekNumber: 0,
      createdAt: new Date(),

      updatedAt: new Date(),

      })

      const now = new Date(launchDate.getTime() + 8 * 60 * 1000) // Week 1
      const originalDateNow = Date.now
      Date.now = jest.fn(() => now.getTime())

      jest.spyOn(gameService, 'getSettings').mockResolvedValue(settings)
      jest.spyOn(prismaClient.gameSettings, 'update').mockResolvedValue({
        ...settings,
        currentWeekNumber: 1,
      })
      jest.spyOn(prismaClient.player, 'findMany').mockResolvedValue([player])
      jest.spyOn(prismaClient.player, 'update').mockResolvedValue(player)

      await service.checkAndPerformReset()

      // Lifetime score should be preserved: 2000 + 8000 = 10000
      expect(prismaClient.player.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          lifetimeTotalScore: 10000,
          weeklyScore: 0,
          lastResetWeekNumber: 1,
        },
      })
    })
  })

  describe('Weekly Reset - Virtual Time (secondsPerDay)', () => {
    it('should calculate week number correctly with secondsPerDay = 60', async () => {
      const settings = createTestGameSettings({
        launchDate,
        secondsPerDay: 60, // 1 minute = 1 day
        weeklyResetEnabled: true,
        weeklyResetDay: 0,
        currentWeekNumber: 0,
      })

      // Test various time points
      const testCases = [
        { timeOffset: 0, expectedWeek: 0 }, // Launch
        { timeOffset: 3 * 60 * 1000, expectedWeek: 0 }, // 3 days = 3 minutes
        { timeOffset: 7 * 60 * 1000, expectedWeek: 1 }, // 7 days = 7 minutes (week 1)
        { timeOffset: 14 * 60 * 1000, expectedWeek: 2 }, // 14 days = 14 minutes (week 2)
        { timeOffset: 21 * 60 * 1000, expectedWeek: 3 }, // 21 days = 21 minutes (week 3)
      ]

      for (const testCase of testCases) {
        const now = new Date(launchDate.getTime() + testCase.timeOffset)
        const originalDateNow = Date.now
        Date.now = jest.fn(() => now.getTime())
        jest.spyOn(gameService, 'getSettings').mockResolvedValue(settings)
        jest.spyOn(prismaClient.gameSettings, 'update').mockResolvedValue(settings)
        jest.spyOn(prismaClient.player, 'findMany').mockResolvedValue([])

        await service.checkAndPerformReset()

        // Check if week number was calculated correctly
        if (testCase.expectedWeek > 0) {
          expect(prismaClient.gameSettings.update).toHaveBeenCalledWith({
            where: { id: 1 },
            data: { currentWeekNumber: testCase.expectedWeek },
          }
        }
      })
    })

    it('should handle reset with secondsPerDay = 3600 (1 hour = 1 day)', async () => {
      const settings = createTestGameSettings({
        launchDate,
        secondsPerDay: 3600, // 1 hour = 1 day
        weeklyResetEnabled: true,
        weeklyResetDay: 0,
        currentWeekNumber: 0,
      })

      const player: Player = {

        id: 1,
        walletAddress: '0xPLAYER1',
        launchDate,
        totalScore: 0,
        currentStreak: 3,
        longestStreak: 3,
        lastPlayDate: launchDate,


        lifetimeTotalScore: 0,
        weeklyScore: 5000,
        weeklyStreak: 3,
        weeklyLongestStreak: 3,
        lastResetWeekNumber: 0,
      createdAt: new Date(),

      updatedAt: new Date(),

      })

      // 8 hours after launch = 8 days = week 1
      const now = new Date(launchDate.getTime() + 8 * 3600 * 1000)
      const originalDateNow = Date.now
      Date.now = jest.fn(() => now.getTime())

      jest.spyOn(gameService, 'getSettings').mockResolvedValue(settings)
      jest.spyOn(prismaClient.gameSettings, 'update').mockResolvedValue({
        ...settings,
        currentWeekNumber: 1,
      })
      jest.spyOn(prismaClient.player, 'findMany').mockResolvedValue([player])
      jest.spyOn(prismaClient.player, 'update').mockResolvedValue(player)

      await service.checkAndPerformReset()

      expect(prismaClient.gameSettings.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { currentWeekNumber: 1 },
      })
    })
  })

  describe('Weekly Reset - Real Calendar Time', () => {
    it('should calculate week number correctly with real calendar weeks', async () => {
      const settings = createTestGameSettings({
        launchDate,
        secondsPerDay: null, // Real time
        weeklyResetEnabled: true,
        weeklyResetDay: 0, // Sunday
        currentWeekNumber: 0,
      })

      // Test various dates
      const testCases = [
        { date: '2025-01-05T00:00:00.000Z', expectedWeek: 0 }, // Launch (Sunday)
        { date: '2025-01-06T00:00:00.000Z', expectedWeek: 0 }, // Monday (same week)
        { date: '2025-01-12T01:00:00.000Z', expectedWeek: 1 }, // Next Sunday 1 AM (new week)
        { date: '2025-01-19T01:00:00.000Z', expectedWeek: 2 }, // Week 2
      ]

      for (const testCase of testCases) {
        const now = new Date(testCase.date)
        const originalDateNow = Date.now
        Date.now = jest.fn(() => now.getTime())
        jest.spyOn(gameService, 'getSettings').mockResolvedValue(settings)
        jest.spyOn(prismaClient.gameSettings, 'update').mockResolvedValue(settings)
        jest.spyOn(prismaClient.player, 'findMany').mockResolvedValue([])

        await service.checkAndPerformReset()

        if (testCase.expectedWeek > 0) {
          expect(prismaClient.gameSettings.update).toHaveBeenCalledWith({
            where: { id: 1 },
            data: { currentWeekNumber: testCase.expectedWeek },
          }
        }
      })
    })

    it('should handle different weeklyResetDay values', async () => {
      const baseSettings = createTestGameSettings({
        launchDate: new Date('2025-01-05T00:00:00.000Z'), // Sunday





        secondsPerDay: null,
        weeklyResetEnabled: true,
        weeklyResetDay: 1, // Monday
        currentWeekNumber: 0,
      })

      // Use a date that's 8 days after launch (should be week 1)
      // Launch: Sunday 2025-01-05, so 8 days later is Monday 2025-01-13
      const monday = new Date('2025-01-13T01:00:00.000Z') // Monday 1 AM, week 1
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(monday.getTime())
      jest.spyOn(gameService, 'getSettings').mockResolvedValue(baseSettings)
      jest.spyOn(prismaClient.gameSettings, 'update').mockResolvedValue({
        ...baseSettings,
        currentWeekNumber: 1,
      })
      jest.spyOn(prismaClient.player, 'findMany').mockResolvedValue([])

      await service.checkAndPerformReset()

      // Should calculate week based on Monday reset day and advance to week 1
      expect(prismaClient.gameSettings.update).toHaveBeenCalled()
    })
  })

  describe('Weekly Reset - Edge Cases', () => {
    it('should handle null lastResetWeekNumber for new players', async () => {
      const settings = createTestGameSettings({
        launchDate,
        secondsPerDay: 60,
        weeklyResetEnabled: true,
        weeklyResetDay: 0,
        currentWeekNumber: 0,
      })

      const newPlayer: Player = {

        id: 1,
        walletAddress: '0xNEW',
        launchDate,
        totalScore: 0,
        currentStreak: 0,
        longestStreak: 0,
        lastPlayDate: null,


        lifetimeTotalScore: 0,
        weeklyScore: 1000,
        weeklyStreak: 1,
        weeklyLongestStreak: 1,
        lastResetWeekNumber: null, // New player
      createdAt: new Date(),

      updatedAt: new Date(),

      })

      const now = new Date(launchDate.getTime() + 8 * 60 * 1000) // Week 1
      const originalDateNow = Date.now
      Date.now = jest.fn(() => now.getTime())

      jest.spyOn(gameService, 'getSettings').mockResolvedValue(settings)
      jest.spyOn(prismaClient.gameSettings, 'update').mockResolvedValue({
        ...settings,
        currentWeekNumber: 1,
      })
      jest.spyOn(prismaClient.player, 'findMany').mockResolvedValue([newPlayer])
      jest.spyOn(prismaClient.player, 'update').mockResolvedValue(newPlayer)

      await service.checkAndPerformReset()

      // Should reset new player
      expect(prismaClient.player.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          lifetimeTotalScore: 1000,
          weeklyScore: 0,
          lastResetWeekNumber: 1,
        },
      })
    })

    it('should handle players with zero weekly score', async () => {
      const settings = createTestGameSettings({
        launchDate,
        secondsPerDay: 60,
        weeklyResetEnabled: true,
        weeklyResetDay: 0,
        currentWeekNumber: 0,
      })

      const player: Player = {

        id: 1,
        walletAddress: '0xPLAYER1',
        launchDate,
        totalScore: 0,
        currentStreak: 0,
        longestStreak: 0,
        lastPlayDate: null,


        lifetimeTotalScore: 5000,
        weeklyScore: 0, // No weekly score
        weeklyStreak: 0,
        weeklyLongestStreak: 0,
        lastResetWeekNumber: 0,
      createdAt: new Date(),

      updatedAt: new Date(),

      })

      const now = new Date(launchDate.getTime() + 8 * 60 * 1000)
      const originalDateNow = Date.now
      Date.now = jest.fn(() => now.getTime())

      jest.spyOn(gameService, 'getSettings').mockResolvedValue(settings)
      jest.spyOn(prismaClient.gameSettings, 'update').mockResolvedValue({
        ...settings,
        currentWeekNumber: 1,
      })
      jest.spyOn(prismaClient.player, 'findMany').mockResolvedValue([player])
      jest.spyOn(prismaClient.player, 'update').mockResolvedValue(player)

      await service.checkAndPerformReset()

      // Lifetime score should remain unchanged (5000 + 0 = 5000)
      expect(prismaClient.player.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          lifetimeTotalScore: 5000,
          weeklyScore: 0,
          lastResetWeekNumber: 1,
        },
      })
    })

    it('should handle multiple consecutive resets', async () => {
      const settings = createTestGameSettings({
        launchDate,
        secondsPerDay: 60,
        weeklyResetEnabled: true,
        weeklyResetDay: 0,
        currentWeekNumber: 0,
      })

      const player: Player = {

        id: 1,
        walletAddress: '0xPLAYER1',
        launchDate,
        totalScore: 0,
        currentStreak: 2,
        longestStreak: 2,
        lastPlayDate: launchDate,


        lifetimeTotalScore: 1000,
        weeklyScore: 2000,
        weeklyStreak: 2,
        weeklyLongestStreak: 2,
        lastResetWeekNumber: 0,
      createdAt: new Date(),

      updatedAt: new Date(),

      })

      // Week 1 reset
      let now = new Date(launchDate.getTime() + 8 * 60 * 1000)
      const originalDateNow = Date.now
      Date.now = jest.fn(() => now.getTime())
      jest.spyOn(gameService, 'getSettings').mockResolvedValue(settings)
      jest.spyOn(prismaClient.gameSettings, 'update').mockResolvedValue({
        ...settings,
        currentWeekNumber: 1,
      })
      jest.spyOn(prismaClient.player, 'findMany').mockResolvedValue([player])
      jest.spyOn(prismaClient.player, 'update').mockResolvedValue({
        ...player,
        lifetimeTotalScore: 3000,
        weeklyScore: 0,
        lastResetWeekNumber: 1,
      })

      await service.checkAndPerformReset()

      // Week 2 reset
      now = new Date(launchDate.getTime() + 15 * 60 * 1000)
      // Date.now already mocked above
      jest.spyOn(gameService, 'getSettings').mockResolvedValue({
        ...settings,
        currentWeekNumber: 1,
      })
      jest.spyOn(prismaClient.gameSettings, 'update').mockResolvedValue({
        ...settings,
        currentWeekNumber: 2,
      })
      jest.spyOn(prismaClient.player, 'findMany').mockResolvedValue([{
        ...player,
        lifetimeTotalScore: 3000,
        weeklyScore: 1500,
        weeklyStreak: 1,
        lastResetWeekNumber: 1,
      }])
      jest.spyOn(prismaClient.player, 'update').mockResolvedValue(player)

      await service.checkAndPerformReset()

      // Should accumulate lifetime score: 3000 + 1500 = 4500
      expect(prismaClient.player.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          lifetimeTotalScore: 4500,
          weeklyScore: 0,
          lastResetWeekNumber: 2,
        },
      })
    })

    it('should handle missed cron runs (catch up on next run)', async () => {
      const settings = createTestGameSettings({
        launchDate,
        secondsPerDay: 60,
        weeklyResetEnabled: true,
        weeklyResetDay: 0,
        currentWeekNumber: 0, // Stuck at week 0
      })

      const player: Player = {

        id: 1,
        walletAddress: '0xPLAYER1',
        launchDate,
        totalScore: 0,
        currentStreak: 5,
        longestStreak: 5,
        lastPlayDate: launchDate,


        lifetimeTotalScore: 1000,
        weeklyScore: 5000,
        weeklyStreak: 5,
        weeklyLongestStreak: 5,
        lastResetWeekNumber: 0,
      createdAt: new Date(),

      updatedAt: new Date(),

      })

      // Cron missed weeks 1 and 2, now catching up at week 3
      const now = new Date(launchDate.getTime() + 22 * 60 * 1000) // Week 3
      const originalDateNow = Date.now
      Date.now = jest.fn(() => now.getTime())

      jest.spyOn(gameService, 'getSettings').mockResolvedValue(settings)
      jest.spyOn(prismaClient.gameSettings, 'update').mockResolvedValue({
        ...settings,
        currentWeekNumber: 3,
      })
      jest.spyOn(prismaClient.player, 'findMany').mockResolvedValue([player])
      jest.spyOn(prismaClient.player, 'update').mockResolvedValue(player)

      await service.checkAndPerformReset()

      // Should reset to week 3
      expect(prismaClient.gameSettings.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { currentWeekNumber: 3 },
      })

      expect(prismaClient.player.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          lifetimeTotalScore: 6000,
          weeklyScore: 0,
          lastResetWeekNumber: 3,
        },
      })
    })

    it('should not reset when week number has not changed', async () => {
      const settings = createTestGameSettings({
        launchDate,
        secondsPerDay: 60,
        weeklyResetEnabled: true,
        weeklyResetDay: 0,
        currentWeekNumber: 1, // Already at week 1
      })

      const now = new Date(launchDate.getTime() + 8 * 60 * 1000) // Still week 1
      const originalDateNow = Date.now
      Date.now = jest.fn(() => now.getTime())

      jest.spyOn(gameService, 'getSettings').mockResolvedValue(settings)
      jest.spyOn(prismaClient.gameSettings, 'update').mockResolvedValue(settings)
      jest.spyOn(prismaClient.player, 'findMany').mockResolvedValue([])

      await service.checkAndPerformReset()

      // Should not update settings (week hasn't changed)
      expect(prismaClient.gameSettings.update).not.toHaveBeenCalled()
      expect(prismaClient.player.findMany).not.toHaveBeenCalled()
    })

    it('should handle null currentWeekNumber in settings (first reset)', async () => {
      const settings = createTestGameSettings({
        launchDate,
        secondsPerDay: 60,
        weeklyResetEnabled: true,
        weeklyResetDay: 0,
        currentWeekNumber: null, // First reset
      })

      const player: Player = {

        id: 1,
        walletAddress: '0xPLAYER1',
        launchDate,
        totalScore: 0,
        currentStreak: 3,
        longestStreak: 3,
        lastPlayDate: launchDate,


        lifetimeTotalScore: 0,
        weeklyScore: 3000,
        weeklyStreak: 3,
        weeklyLongestStreak: 3,
        lastResetWeekNumber: null,
      createdAt: new Date(),

      updatedAt: new Date(),

      })

      const now = new Date(launchDate.getTime() + 8 * 60 * 1000) // Week 1
      const originalDateNow = Date.now
      Date.now = jest.fn(() => now.getTime())

      jest.spyOn(gameService, 'getSettings').mockResolvedValue(settings)
      jest.spyOn(prismaClient.gameSettings, 'update').mockResolvedValue({
        ...settings,
        currentWeekNumber: 1,
      })
      jest.spyOn(prismaClient.player, 'findMany').mockResolvedValue([player])
      jest.spyOn(prismaClient.player, 'update').mockResolvedValue(player)

      await service.checkAndPerformReset()

      // Should perform first reset
      expect(prismaClient.gameSettings.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { currentWeekNumber: 1 },
      })
    })
  })

  describe('Weekly Reset - Multiple Players', () => {
    it('should reset multiple players in the same operation', async () => {
      const settings = createTestGameSettings({
        launchDate,
        secondsPerDay: 60,
        weeklyResetEnabled: true,
        weeklyResetDay: 0,
        currentWeekNumber: 0,
      })

      const players: Player[] = [
        {
          id: 1,
          walletAddress: '0xPLAYER1',
          launchDate,
          totalScore: 0,
          currentStreak: 5,
          longestStreak: 5,
          lastPlayDate: launchDate,
          createdAt: launchDate,
          updatedAt: launchDate,
          lifetimeTotalScore: 1000,
          weeklyScore: 5000,
          weeklyStreak: 5,
          weeklyLongestStreak: 5,
          lastResetWeekNumber: 0,
        },
        {
          id: 2,
          walletAddress: '0xPLAYER2',
          launchDate,
          totalScore: 0,
          currentStreak: 3,
          longestStreak: 3,
          lastPlayDate: launchDate,
          createdAt: launchDate,
          updatedAt: launchDate,
          lifetimeTotalScore: 500,
          weeklyScore: 3000,
          weeklyStreak: 3,
          weeklyLongestStreak: 3,
          lastResetWeekNumber: null,
        },
        {
          id: 3,
          walletAddress: '0xPLAYER3',
          launchDate,
          totalScore: 0,
          currentStreak: 7,
          longestStreak: 7,
          lastPlayDate: launchDate,
          createdAt: launchDate,
          updatedAt: launchDate,
          lifetimeTotalScore: 2000,
          weeklyScore: 10000,
          weeklyStreak: 7,
          weeklyLongestStreak: 7,
          lastResetWeekNumber: 0,
        },
      ]

      const now = new Date(launchDate.getTime() + 8 * 60 * 1000)
      const originalDateNow = Date.now
      Date.now = jest.fn(() => now.getTime())

      jest.spyOn(gameService, 'getSettings').mockResolvedValue(settings)
      jest.spyOn(prismaClient.gameSettings, 'update').mockResolvedValue({
        ...settings,
        currentWeekNumber: 1,
      })
      jest.spyOn(prismaClient.player, 'findMany').mockResolvedValue(players)
      jest.spyOn(prismaClient.player, 'update').mockResolvedValue(players[0])

      await service.checkAndPerformReset()

      // Should reset all 3 players
      expect(prismaClient.player.update).toHaveBeenCalledTimes(3)

      // Player 1: 1000 + 5000 = 6000
      expect(prismaClient.player.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          lifetimeTotalScore: 6000,
          weeklyScore: 0,
          lastResetWeekNumber: 1,
        },
      })

      // Player 2: 500 + 3000 = 3500
      expect(prismaClient.player.update).toHaveBeenCalledWith({
        where: { id: 2 },
        data: {
          lifetimeTotalScore: 3500,
          weeklyScore: 0,
          lastResetWeekNumber: 1,
        },
      })

      // Player 3: 2000 + 10000 = 12000
      expect(prismaClient.player.update).toHaveBeenCalledWith({
        where: { id: 3 },
        data: {
          lifetimeTotalScore: 12000,
          weeklyScore: 0,
          lastResetWeekNumber: 1,
        },
      })
    })

    it('should only reset players that need reset (skip already reset players)', async () => {
      const settings = createTestGameSettings({
        launchDate,
        secondsPerDay: 60,
        weeklyResetEnabled: true,
        weeklyResetDay: 0,
        currentWeekNumber: 0,
      })

      const players: Player[] = [
        {
          id: 1,
          walletAddress: '0xPLAYER1',
          launchDate,
          totalScore: 0,
          currentStreak: 5,
          longestStreak: 5,
          lastPlayDate: launchDate,
          createdAt: launchDate,
          updatedAt: launchDate,
          lifetimeTotalScore: 1000,
          weeklyScore: 5000,
          weeklyStreak: 5,
          weeklyLongestStreak: 5,
          lastResetWeekNumber: 0, // Needs reset
        },
        {
          id: 2,
          walletAddress: '0xPLAYER2',
          launchDate,
          totalScore: 0,
          currentStreak: 3,
          longestStreak: 3,
          lastPlayDate: launchDate,
          createdAt: launchDate,
          updatedAt: launchDate,
          lifetimeTotalScore: 500,
          weeklyScore: 3000,
          weeklyStreak: 3,
          weeklyLongestStreak: 3,
          lastResetWeekNumber: 1, // Already reset (shouldn't be in query results)
        },
      ]

      const now = new Date(launchDate.getTime() + 8 * 60 * 1000)
      const originalDateNow = Date.now
      Date.now = jest.fn(() => now.getTime())

      jest.spyOn(gameService, 'getSettings').mockResolvedValue(settings)
      jest.spyOn(prismaClient.gameSettings, 'update').mockResolvedValue({
        ...settings,
        currentWeekNumber: 1,
      })
      // Only player 1 should be returned (player 2 already reset)
      jest.spyOn(prismaClient.player, 'findMany').mockResolvedValue([players[0]])
      jest.spyOn(prismaClient.player, 'update').mockResolvedValue(players[0])

      await service.checkAndPerformReset()

      // Should only reset player 1
      expect(prismaClient.player.update).toHaveBeenCalledTimes(1)
      expect(prismaClient.player.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          lastResetWeekNumber: 1,
        }),
      })
    })
  })

  describe('Weekly Reset - No Players', () => {
    it('should handle case when no players need reset', async () => {
      const settings = createTestGameSettings({
        launchDate,
        secondsPerDay: 60,
        weeklyResetEnabled: true,
        weeklyResetDay: 0,
        currentWeekNumber: 0,
      })

      const now = new Date(launchDate.getTime() + 8 * 60 * 1000)
      const originalDateNow = Date.now
      Date.now = jest.fn(() => now.getTime())

      jest.spyOn(gameService, 'getSettings').mockResolvedValue(settings)
      jest.spyOn(prismaClient.gameSettings, 'update').mockResolvedValue({
        id: 1,
        streakBaseMultiplier: 1.0,
        streakIncrementPerDay: 0.1,
        secondsPerDay: 60,
        currentWeekNumber: 1,
        referralExtraPlays: 3,
        createdAt: launchDate,
        updatedAt: launchDate,
      })
      jest.spyOn(prismaClient.player, 'findMany').mockResolvedValue([]) // No players
      jest.spyOn(prismaClient.player, 'update').mockResolvedValue({} as Player)

      await service.checkAndPerformReset()

      // Should update week number but not update any players
      expect(prismaClient.gameSettings.update).toHaveBeenCalled()
      expect(prismaClient.player.update).not.toHaveBeenCalled()
    })
  })
})
