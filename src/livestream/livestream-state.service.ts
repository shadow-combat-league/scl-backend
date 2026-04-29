import { Injectable } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { MetricsService } from '../metrics/metrics.service'
import {
  defaultLivestreamMatchState,
  LivestreamMatchState,
  sanitizeLivestreamState,
} from './livestream.types'

@Injectable()
export class LivestreamStateService {
  private state: LivestreamMatchState = JSON.parse(JSON.stringify(defaultLivestreamMatchState))

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly metricsService: MetricsService
  ) {}

  getState(): LivestreamMatchState {
    this.state = sanitizeLivestreamState(this.state, defaultLivestreamMatchState)
    return JSON.parse(JSON.stringify(this.state))
  }

  updateState(candidate: unknown, source: 'http' | 'websocket'): LivestreamMatchState {
    // Migrate existing in-memory state forward when new keys are introduced.
    this.state = sanitizeLivestreamState(this.state, defaultLivestreamMatchState)
    this.state = sanitizeLivestreamState(candidate, this.state)
    this.metricsService.livestreamStateUpdates.inc({ source })
    this.eventEmitter.emit('livestream.state.updated', this.getState())
    return this.getState()
  }

  resetState(): LivestreamMatchState {
    this.state = JSON.parse(JSON.stringify(defaultLivestreamMatchState))
    this.metricsService.livestreamStateUpdates.inc({ source: 'http' })
    this.eventEmitter.emit('livestream.state.updated', this.getState())
    return this.getState()
  }
}
