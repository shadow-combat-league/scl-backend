import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common'
import { LivestreamLoginDto } from './dto/livestream-login.dto'
import { LivestreamAuthService } from './livestream-auth.service'
import { LivestreamStateService } from './livestream-state.service'

@Controller('api/livestream')
export class LivestreamController {
  constructor(
    private readonly livestreamAuthService: LivestreamAuthService,
    private readonly livestreamStateService: LivestreamStateService
  ) {}

  @Post('auth/login')
  login(@Body() body: LivestreamLoginDto) {
    const token = this.livestreamAuthService.authenticateWithPassword(body.role, body.password)
    if (!token) throw new UnauthorizedException('Invalid password')
    return {
      token,
      role: body.role,
    }
  }

  @Get('auth/validate')
  validateToken(@Headers('authorization') authorization?: string) {
    const token = this.livestreamAuthService.extractTokenFromAuthorizationHeader(authorization)
    const payload = token ? this.livestreamAuthService.validateToken(token) : null
    if (!payload) throw new UnauthorizedException('Invalid token')
    return {
      valid: true,
      role: payload.role,
      exp: payload.exp,
    }
  }

  @Get('state')
  getState(@Headers('authorization') authorization?: string) {
    const payload = this.authenticate(authorization)
    return {
      role: payload.role,
      state: this.livestreamStateService.getState(),
    }
  }

  @Post('state')
  updateState(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    const payload = this.authenticate(authorization)
    if (payload.role !== 'judge') throw new ForbiddenException('Judge role required')
    return this.livestreamStateService.updateState(body, 'http')
  }

  private authenticate(authorization?: string) {
    const token = this.livestreamAuthService.extractTokenFromAuthorizationHeader(authorization)
    const payload = token ? this.livestreamAuthService.validateToken(token) : null
    if (!payload) throw new UnauthorizedException('Invalid token')
    return payload
  }
}
