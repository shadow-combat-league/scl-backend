import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHmac, timingSafeEqual } from 'crypto'
import { MetricsService } from '../metrics/metrics.service'
import { LivestreamRole } from './livestream.types'

interface LivestreamTokenPayload {
  role: LivestreamRole
  iat: number
  exp: number
}

@Injectable()
export class LivestreamAuthService {
  private readonly logger = new Logger(LivestreamAuthService.name)
  private readonly secret: string
  private readonly judgePassword: string
  private readonly overlayPassword: string
  private readonly tokenTtlSeconds: number

  constructor(
    private readonly configService: ConfigService,
    private readonly metricsService: MetricsService
  ) {
    this.secret = this.configService.get<string>('LIVESTREAM_AUTH_SECRET') || 'livestream-dev-secret-change-me'
    this.judgePassword = this.configService.get<string>('LIVESTREAM_JUDGE_PASSWORD') || 'judge'
    this.overlayPassword = this.configService.get<string>('LIVESTREAM_OVERLAY_PASSWORD') || 'overlay'
    this.tokenTtlSeconds = Number(this.configService.get<string>('LIVESTREAM_TOKEN_TTL_SECONDS') || '43200')

    if (this.secret === 'livestream-dev-secret-change-me' && this.configService.get<string>('NODE_ENV') === 'production') {
      this.logger.warn('LIVESTREAM_AUTH_SECRET is using the development fallback value')
    }
  }

  authenticateWithPassword(role: LivestreamRole, password: string): string | null {
    const expected = role === 'judge' ? this.judgePassword : this.overlayPassword
    const success = this.safeCompare(password, expected)
    this.metricsService.livestreamAuthAttempts.inc({ role, status: success ? 'success' : 'failure' })
    if (!success) return null
    return this.signToken(role)
  }

  validateToken(token: string): LivestreamTokenPayload | null {
    if (!token) {
      this.metricsService.livestreamAuthValidations.inc({ status: 'missing' })
      return null
    }

    const parts = token.split('.')
    if (parts.length !== 2) {
      this.metricsService.livestreamAuthValidations.inc({ status: 'malformed' })
      return null
    }

    const [encodedPayload, signature] = parts
    const expectedSignature = this.sign(encodedPayload)
    if (!this.safeCompare(signature, expectedSignature)) {
      this.metricsService.livestreamAuthValidations.inc({ status: 'invalid_signature' })
      return null
    }

    try {
      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as LivestreamTokenPayload
      const now = Math.floor(Date.now() / 1000)
      if (!payload?.role || !payload?.exp || payload.exp <= now) {
        this.metricsService.livestreamAuthValidations.inc({ status: 'expired' })
        return null
      }
      this.metricsService.livestreamAuthValidations.inc({ status: 'success' })
      return payload
    } catch {
      this.metricsService.livestreamAuthValidations.inc({ status: 'decode_error' })
      return null
    }
  }

  extractTokenFromAuthorizationHeader(authorizationHeader?: string): string | null {
    if (!authorizationHeader) return null
    if (!authorizationHeader.startsWith('Bearer ')) return null
    return authorizationHeader.slice('Bearer '.length).trim()
  }

  private signToken(role: LivestreamRole): string {
    const now = Math.floor(Date.now() / 1000)
    const payload: LivestreamTokenPayload = {
      role,
      iat: now,
      exp: now + this.tokenTtlSeconds,
    }
    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const signature = this.sign(encodedPayload)
    return `${encodedPayload}.${signature}`
  }

  private sign(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('base64url')
  }

  private safeCompare(input: string, expected: string): boolean {
    const inputBuffer = Buffer.from(input || '')
    const expectedBuffer = Buffer.from(expected || '')
    if (inputBuffer.length !== expectedBuffer.length) return false
    return timingSafeEqual(inputBuffer, expectedBuffer)
  }
}
