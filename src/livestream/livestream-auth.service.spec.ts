import { Test, TestingModule } from '@nestjs/testing'
import { ConfigService } from '@nestjs/config'
import { LivestreamAuthService } from './livestream-auth.service'
import { MetricsService } from '../metrics/metrics.service'

describe('LivestreamAuthService', () => {
  let service: LivestreamAuthService

  const metricsMock = {
    livestreamAuthAttempts: { inc: jest.fn() },
    livestreamAuthValidations: { inc: jest.fn() },
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LivestreamAuthService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              const map: Record<string, string> = {
                LIVESTREAM_AUTH_SECRET: 'test-secret',
                LIVESTREAM_JUDGE_PASSWORD: 'judge-pass',
                LIVESTREAM_OVERLAY_PASSWORD: 'overlay-pass',
                LIVESTREAM_TOKEN_TTL_SECONDS: '3600',
                NODE_ENV: 'test',
              }
              return map[key]
            },
          },
        },
        {
          provide: MetricsService,
          useValue: metricsMock,
        },
      ],
    }).compile()

    service = module.get<LivestreamAuthService>(LivestreamAuthService)
  })

  it('creates token for correct judge password', () => {
    const token = service.authenticateWithPassword('judge', 'judge-pass')
    expect(token).toBeDefined()
    expect(typeof token).toBe('string')
  })

  it('rejects incorrect password', () => {
    const token = service.authenticateWithPassword('overlay', 'wrong')
    expect(token).toBeNull()
  })

  it('validates signed token', () => {
    const token = service.authenticateWithPassword('overlay', 'overlay-pass')
    expect(token).toBeDefined()
    const payload = service.validateToken(token as string)
    expect(payload?.role).toBe('overlay')
  })
})
