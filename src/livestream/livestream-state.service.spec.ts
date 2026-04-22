import { Test, TestingModule } from '@nestjs/testing'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { LivestreamStateService } from './livestream-state.service'
import { MetricsService } from '../metrics/metrics.service'

describe('LivestreamStateService', () => {
  let service: LivestreamStateService

  const eventEmitterMock = {
    emit: jest.fn(),
  }

  const metricsMock = {
    livestreamStateUpdates: { inc: jest.fn() },
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LivestreamStateService,
        { provide: EventEmitter2, useValue: eventEmitterMock },
        { provide: MetricsService, useValue: metricsMock },
      ],
    }).compile()

    service = module.get<LivestreamStateService>(LivestreamStateService)
  })

  it('clamps invalid updates to safe values', () => {
    const updated = service.updateState(
      {
        roundNumber: 999,
        robot1: {
          maxHp: 10,
          currentHp: 99999,
          heartRate: 999,
        },
      },
      'http'
    )

    expect(updated.roundNumber).toBe(99)
    expect(updated.robot1.maxHp).toBe(100)
    expect(updated.robot1.currentHp).toBe(100)
    expect(updated.robot1.heartRate).toBe(220)
  })
})
