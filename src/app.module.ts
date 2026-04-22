import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { CacheModule } from '@nestjs/cache-manager'
import { ScheduleModule } from '@nestjs/schedule'
import { TerminusModule } from '@nestjs/terminus'
import { EventEmitterModule } from '@nestjs/event-emitter'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { GameModule } from './game/game.module'
import { BlockchainModule } from './blockchain/blockchain.module'
import { WordpressModule } from './wordpress/wordpress.module'
import { HealthModule } from './health/health.module'
import { MetricsModule } from './metrics/metrics.module'
import { KickChatModule } from './kick-chat/kick-chat.module'
import { KickAuthModule } from './kick-auth/kick-auth.module'
import { LivestreamModule } from './livestream/livestream.module'
import { MetricsInterceptor } from './metrics/metrics.interceptor'
import { RedisConfig } from './config/redis.config'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    CacheModule.registerAsync({
      useClass: RedisConfig,
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    TerminusModule,
    EventEmitterModule.forRoot(),
    MetricsModule,
    GameModule,
    BlockchainModule,
    WordpressModule,
    HealthModule,
    KickChatModule,
    KickAuthModule,
    LivestreamModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: MetricsInterceptor,
    },
  ],
})
export class AppModule {}
