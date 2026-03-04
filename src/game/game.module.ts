import { Module, forwardRef } from '@nestjs/common'
import { GameController } from './game.controller'
import { GameService } from './game.service'
import { WeeklyResetService } from './weekly-reset.service'
import { ReferralService } from './referral.service'
import { BonusService } from './bonus.service'
import { PrismaService } from '../prisma/prisma.service'
import { MetricsService } from '../metrics/metrics.service'
import { GameStateGuard } from './guards/game-state.guard'
import { WordpressModule } from '../wordpress/wordpress.module'
import { CommonModule } from '../common/common.module'

@Module({
  imports: [WordpressModule, CommonModule],
  controllers: [GameController],
  providers: [GameService, WeeklyResetService, ReferralService, BonusService, PrismaService, GameStateGuard],
  exports: [GameService, PrismaService, ReferralService, BonusService],
})
export class GameModule {}
