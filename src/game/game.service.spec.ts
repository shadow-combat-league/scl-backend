import { Test, TestingModule } from '@nestjs/testing'
import { CACHE_MANAGER } from '@nestjs/cache-manager'
import { ConfigService } from '@nestjs/config'
import { GameService } from './game.service'
import { Cache } from 'cache-manager'
import { PrismaService, PrismaClient } from '../prisma/prisma.service'
import { GameSettings, createTestGameSettings } from './types/game-settings.type'

type Player = Awaited<ReturnType<PrismaClient['player']['findUnique']>>

describe('GameService time scaling', () => {
  let service: GameService
  let prisma: PrismaService
  let cache: Cache

  const walletAddress = '0xTEST'

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
            },
            gameSession: {
              count: jest.fn(),
              findFirst: jest.fn(),
              findMany: jest.fn(),
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
    cache = module.get<Cache>(CACHE_MANAGER)
  })

  it('honors a short virtual day (secondsPerDay) when calculating playsRemaining and nextAvailableAt', async () => {
    const launchDate = new Date('2025-01-01T00:00:00.000Z')
    const settings = createTestGameSettings({
      launchDate,
      secondsPerDay: 120, // 2 minutes = 1 game day
    })

    const prismaClient = prisma as PrismaClient
    jest.spyOn(prismaClient.gameSettings, 'findUnique').mockResolvedValue(settings)
    jest.spyOn(cache, 'get').mockResolvedValue(null)

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

    jest.spyOn(prismaClient.player, 'findUnique').mockResolvedValue(player)
    jest.spyOn(prismaClient.player, 'create').mockResolvedValue(player)

    jest.spyOn(prismaClient.gameSession, 'count').mockResolvedValue(0)
    jest.spyOn(prismaClient.gameSession, 'findFirst').mockResolvedValue(null)
    jest.spyOn(prismaClient.gameSession, 'findMany').mockResolvedValue([])

    const now = new Date(launchDate.getTime() + 5 * 120 * 1000) // 5 virtual days later
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime())

    const status = await service.getPlayerStatus(walletAddress)

    // With 5 virtual days passed, player should have at least 5 allowed plays
    expect(status.playsRemaining).toBeGreaterThanOrEqual(5)

    if (!status.canPlay) {
      expect(status.nextAvailableAt).not.toBeNull()
      expect(status.secondsToNextPlay).not.toBeNull()
      expect(status.secondsToNextPlay).toBeLessThanOrEqual(120)
    }
  })
})

