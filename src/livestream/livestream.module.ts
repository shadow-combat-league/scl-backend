import { Module } from '@nestjs/common'
import { LivestreamController } from './livestream.controller'
import { LivestreamAuthService } from './livestream-auth.service'
import { LivestreamStateService } from './livestream-state.service'
import { LivestreamGateway } from './livestream.gateway'

@Module({
  controllers: [LivestreamController],
  providers: [LivestreamAuthService, LivestreamStateService, LivestreamGateway],
  exports: [LivestreamAuthService, LivestreamStateService, LivestreamGateway],
})
export class LivestreamModule {}
