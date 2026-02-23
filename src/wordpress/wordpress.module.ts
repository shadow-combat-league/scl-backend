import { Module } from '@nestjs/common'
import { HttpModule } from '@nestjs/axios'
import { WordpressController } from './wordpress.controller'
import { WordpressService } from './wordpress.service'
import { CommonModule } from '../common/common.module'

@Module({
  imports: [HttpModule.register({ timeout: 10000 }), CommonModule],
  controllers: [WordpressController],
  providers: [WordpressService],
  exports: [WordpressService],
})
export class WordpressModule {}
