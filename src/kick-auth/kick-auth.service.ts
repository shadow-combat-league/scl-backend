import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import axios from 'axios'
import { MetricsService } from '../metrics/metrics.service'

@Injectable()
export class KickAuthService {
  private readonly logger = new Logger(KickAuthService.name)

  constructor(
    private readonly configService: ConfigService,
    private readonly metricsService: MetricsService,
  ) {}

  async exchangeCodeForToken(params: {
    code: string
    codeVerifier: string
    redirectUri: string
  }): Promise<{ access_token: string }> {
    const { code, codeVerifier, redirectUri } = params

    const clientId = this.configService.get<string>('KICK_CLIENT_ID')
    const clientSecret = this.configService.get<string>('KICK_CLIENT_SECRET')

    if (!clientId) {
      this.logger.error('KICK_CLIENT_ID is not configured')
      throw new Error('Kick OAuth client ID not configured on server')
    }

    if (!clientSecret) {
      this.logger.error('KICK_CLIENT_SECRET is not configured')
      throw new Error('Kick OAuth client secret not configured on server')
    }

    try {
      const response = await axios.post(
        'https://id.kick.com/oauth/token',
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
          code_verifier: codeVerifier,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      )

      // Log full response from Kick
      this.logger.log('Kick OAuth token exchange response:', JSON.stringify(response.data, null, 2))
      this.logger.log('Response keys:', Object.keys(response.data || {}))

      const accessToken = response.data?.access_token
      if (!accessToken) {
        this.logger.error('No access_token in Kick OAuth response', response.data)
        throw new Error('No access token in Kick OAuth response')
      }

      this.logger.log(`Access token received (length: ${accessToken.length})`)
      this.metricsService.kickOAuthExchanges.inc({ status: 'success' })

      return { access_token: accessToken }
    } catch (error: any) {
      const status = error?.response?.status
      const data = error?.response?.data
      this.logger.error(
        `Error exchanging code for token with Kick (status ${status ?? 'unknown'})`,
        JSON.stringify(data ?? error?.message ?? 'unknown'),
      )
      this.metricsService.kickOAuthExchanges.inc({ status: 'error' })
      throw new Error('Failed to exchange code for Kick access token')
    }
  }
}

