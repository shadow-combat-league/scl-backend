import { Test, TestingModule } from '@nestjs/testing'
import { CACHE_MANAGER } from '@nestjs/cache-manager'
import { ConfigService } from '@nestjs/config'
import { GameService } from './game.service'
import { Cache } from 'cache-manager'
import { PrismaService, PrismaClient } from '../prisma/prisma.service'
import { BadRequestException } from '@nestjs/common'
import { GameSettings, createTestGameSettings } from './types/game-settings.type'

type Player = Awaited<ReturnType<PrismaClient['player']['findUnique']>>
type GameSession = Awaited<ReturnType<PrismaClient['gameSession']['create']>>

describe('GameService - Weekly Reset Integration', () => {
  let service: GameService
  let prisma: PrismaService
  let prismaClient: PrismaClient
  let cache: Cache

  const walletAddress = '0xTEST'
  const launchDate = new Date('2025-01-01T00:00:00.000Z')

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GameService,
        {
          provide: PrismaService,
          useValue: {
            gameSettings: {
              findUnique: jest.fn(),
              upsert: jest.fn(),
            },
            player: {
              findUnique: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
              count: jest.fn(),
              findMany: jest.fn(),
            },
            gameSession: {
              count: jest.fn(),
              findFirst: jest.fn(),
              findMany: jest.fn(),
              create: jest.fn(),
            },
            playerStreak: {
              create: jest.fn(),
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

    service = module.get<GameService>(GameService)
    prisma = module.get<PrismaService>(PrismaService)
    prismaClient = prisma as PrismaClient
    cache = module.get<Cache>(CACHE_MANAGER)
  })

  describe('Score Submission - Weekly Reset Enabled', () => {
    it('should accumulate weekly score when weekly reset is enabled', async () => {
      const settings = createTestGameSettings({
        launchDate,
        weeklyResetEnabled: true,
        weeklyResetDay: 0,
        currentWeekNumber: 1,
        secondsPerDay: null,
      })

      const player: Player = {
        id: 1,
        walletAddress,
        launchDate,
        totalScore: 0,
        currentStreak: 0,
        longestStreak: 0,
        lastPlayDate: null,
        createdAt: launchDate,
        updatedAt: launchDate,
        lifetimeTotalScore: 0,
        weeklyScore: 0,
        weeklyStreak: 0,
        weeklyLongestStreak: 0,
        lastResetWeekNumber: null,
      }

      jest.spyOn(service, 'getSettings').mockResolvedValue(settings)
      jest.spyOn(prismaClient.player, 'update').mockResolvedValue(player)

      const now = new Date(launchDate.getTime() + 24 * 60 * 60 * 1000)
      jest.spyOn(Date, 'now').mockReturnValue(now.getTime())

      // Submit score with weekly reset disabled
      await service.submitScore({
        walletAddress,
        score: 1000,
      })

      // Now: enable weekly reset
      const settingsWithReset = createTestGameSettings({
        launchDate,
        weeklyResetEnabled: true,
        weeklyResetDay: 0,
        currentWeekNumber: 1,
        secondsPerDay: null,
      })

      jest.spyOn(service, 'getSettings').mockResolvedValue(settingsWithReset)
      jest.spyOn(prismaClient.player, 'findUnique').mockResolvedValue({
        id: 1,
        walletAddress,
        launchDate,
        totalScore: 11200,
        currentStreak: 0,
        longestStreak: 0,
        lastPlayDate: null,
        createdAt: launchDate,
        updatedAt: launchDate,
        lifetimeTotalScore: 0,
        weeklyScore: 0,
        weeklyStreak: 0,
        weeklyLongestStreak: 0,
        lastResetWeekNumber: null,
      })

      // Submit score with weekly reset enabled
      await service.submitScore({
        walletAddress,
        score: 1000,
      })

      // Should now use weekly score
      expect(prismaClient.player.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          weeklyScore: expect.any(Number),
        }),
      })
    })
  })
})
