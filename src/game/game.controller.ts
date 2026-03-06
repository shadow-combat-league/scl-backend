import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common'
import { GameService } from './game.service'
import { ReferralService } from './referral.service'
import { BonusService, BonusType } from './bonus.service'
import { SubmitScoreDto } from './dto/submit-score.dto'
import { GameStateGuard } from './guards/game-state.guard'

@Controller('api/game')
export class GameController {
  constructor(
    private readonly gameService: GameService,
    private readonly referralService: ReferralService,
    private readonly bonusService: BonusService,
  ) {}

  @Get('state')
  async getGameState() {
    return this.gameService.getGameState()
  }

  @Get('status/:walletAddress')
  @UseGuards(GameStateGuard)
  async getStatus(@Param('walletAddress') walletAddress: string) {
    return this.gameService.getPlayerStatus(walletAddress)
  }

  @Post('submit')
  @UseGuards(GameStateGuard)
  async submitScore(@Body() dto: SubmitScoreDto) {
    return this.gameService.submitScore(dto)
  }

  @Get('leaderboard')
  async getLeaderboard(
    @Query('limit') limit?: string,
    @Query('page') page?: string,
    @Query('userAddress') userAddress?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 10
    const pageNum = page ? parseInt(page, 10) : 1
    return this.gameService.getLeaderboard(limitNum, pageNum, userAddress)
  }

  @Get('history/:walletAddress')
  @UseGuards(GameStateGuard)
  async getHistory(@Param('walletAddress') walletAddress: string, @Query('limit') limit?: string) {
    const limitNum = limit ? parseInt(limit, 10) : 50
    return this.gameService.getPlayerHistory(walletAddress, limitNum)
  }

  @Get('test-cache')
  async testCache() {
    // Force cache usage for testing
    const settings = await this.gameService.getSettings()
    return { 
      message: 'Cache test - check Redis for game:settings key',
      settingsId: settings.id,
      timestamp: new Date().toISOString()
    }
  }

  @Post('referral/apply')
  async applyReferralCode(
    @Body() body: { walletAddress: string; code: string },
  ) {
    return this.referralService.applyReferralCode(body.walletAddress, body.code)
  }

  @Get('referral/:walletAddress')
  async getReferralInfo(@Param('walletAddress') walletAddress: string) {
    return this.referralService.getReferralInfo(walletAddress)
  }

  @Post('bonus/claim')
  async claimBonus(
    @Body() body: { walletAddress: string; bonusType: BonusType },
  ) {
    return this.bonusService.claimBonus(body.walletAddress, body.bonusType)
  }

  @Get('bonus/:walletAddress')
  async getBonusStatus(@Param('walletAddress') walletAddress: string) {
    return this.bonusService.getBonusStatus(walletAddress)
  }

  @Get('checkin/status/:walletAddress')
  async getCheckInStatus(@Param('walletAddress') walletAddress: string) {
    return this.gameService.getCheckInStatus(walletAddress)
  }

  @Get('debug/:walletAddress')
  async getDebugInfo(@Param('walletAddress') walletAddress: string) {
    const status = await this.gameService.getPlayerStatus(walletAddress)
    const referral = await this.referralService.getReferralInfo(walletAddress)
    return { status, referral }
  }

  @Get('test-wordpress-settings')
  async testWordPressSettings() {
    const settings = await this.gameService.getSettings()
    return {
      message: 'Game settings fetched from WordPress (single source of truth)',
      settings: {
        launchDate: settings.launchDate.toISOString(),
        gameState: settings.gameState,
        weeklyResetEnabled: settings.weeklyResetEnabled,
        weeklyResetDay: settings.weeklyResetDay,
        weeklyResetHour: settings.weeklyResetHour,
        weeklyResetMinute: settings.weeklyResetMinute,
        streakBaseMultiplier: settings.streakBaseMultiplier,
        streakIncrementPerDay: settings.streakIncrementPerDay,
        referralExtraPlays: settings.referralExtraPlays,
      },
      timestamp: new Date().toISOString(),
    }
  }
}
