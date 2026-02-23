import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import * as dotenv from 'dotenv'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../src/app.module'
import { GameService } from '../src/game/game.service'
import { WeeklyResetService } from '../src/game/weekly-reset.service'

dotenv.config()

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required')
}

const pool = new Pool({ connectionString: databaseUrl })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

const TEST_WALLETS = [
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
  '0x3333333333333333333333333333333333333333',
]

function getRandomScore(): number {
  return Math.floor(Math.random() * 9900) + 100
}

async function main() {
  console.log('🚀 Starting 3-Week Weekly Reset Simulation Test (Simplified)\n')

  const app = await NestFactory.createApplicationContext(AppModule)
  const gameService = app.get(GameService)
  const weeklyResetService = app.get(WeeklyResetService)

  try {
    // Set launch date to 30 days ago so players have plenty of plays
    const launchDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    console.log(`📅 Using test launch date: ${launchDate.toISOString()} (30 days ago)\n`)

    // Enable fast time mode: 10 seconds = 1 day
    await prisma.gameSettings.update({
      where: { id: 1 },
      data: { secondsPerDay: 10, currentWeekNumber: 0 },
    })
    console.log('✅ Enabled fast time mode: 10 seconds = 1 day\n')

    // Clean up and create test players
    console.log('🧹 Setting up test players...')
    for (const wallet of TEST_WALLETS) {
      await prisma.player.deleteMany({ where: { walletAddress: wallet } })
      await prisma.player.create({
        data: {
          walletAddress: wallet,
          launchDate,
          totalScore: 0,
          currentStreak: 0,
          longestStreak: 0,
          lifetimeTotalScore: 0,
          weeklyScore: 0,
          weeklyStreak: 0,
          weeklyLongestStreak: 0,
        },
      })
    }
    console.log('✅ Test players created\n')

    // Simulate 3 weeks
    for (let week = 0; week < 3; week++) {
      console.log(`\n${'='.repeat(60)}`)
      console.log(`📅 WEEK ${week} - Starting simulation`)
      console.log(`${'='.repeat(60)}\n`)

      // Simulate 7 days of gameplay
      for (let day = 0; day < 7; day++) {
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
        console.log(`\n🌅 Day ${day} (${dayNames[day]})`)

        // Wait for next day (10 seconds = 1 day)
        if (day > 0) {
          await new Promise(resolve => setTimeout(resolve, 11000)) // 11 seconds to ensure next day
        }

        // Each player plays once per day
        for (const wallet of TEST_WALLETS) {
          const score = getRandomScore()
          console.log(`   ${wallet.substring(0, 10)}... submitting score: ${score}`)
          try {
            await gameService.submitScore({ walletAddress: wallet, score })
          } catch (error: any) {
            console.error(`   ❌ Error: ${error.message}`)
          }
        }

        // Take snapshot after each day
        for (const wallet of TEST_WALLETS) {
          const player = await prisma.player.findUnique({ where: { walletAddress: wallet } })
          if (player) {
            console.log(`   📸 ${wallet.substring(0, 10)}...: Weekly=${player.weeklyScore}, Lifetime=${player.lifetimeTotalScore}`)
          }
        }
      }

      // End of week snapshot
      console.log(`\n📊 End of Week ${week} - Final Status:`)
      for (const wallet of TEST_WALLETS) {
        const player = await prisma.player.findUnique({ where: { walletAddress: wallet } })
        if (player) {
          console.log(`\n   ${wallet.substring(0, 10)}...:`)
          console.log(`      Weekly Score: ${player.weeklyScore}`)
          console.log(`      Lifetime Score: ${player.lifetimeTotalScore}`)
          console.log(`      Weekly Streak: ${player.weeklyStreak}`)
          console.log(`      Current Streak: ${player.currentStreak}`)
          console.log(`      Last Reset Week: ${player.lastResetWeekNumber ?? 'null'}`)
        }
      }

      // Trigger weekly reset
      if (week < 2) {
        console.log(`\n🔄 Triggering weekly reset...`)
        
        // Wait 7 days (70 seconds) for week to pass
        console.log('   ⏳ Waiting 70 seconds (7 days) for week to pass...')
        await new Promise(resolve => setTimeout(resolve, 70000))

        // Trigger reset
        await weeklyResetService.checkAndPerformReset()
        await new Promise(resolve => setTimeout(resolve, 2000))

        const settings = await prisma.gameSettings.findUnique({ where: { id: 1 } })
        console.log(`✅ Reset complete. New week number: ${settings?.currentWeekNumber ?? 'null'}\n`)

        // Verify reset
        console.log('🔍 Verifying reset...')
        for (const wallet of TEST_WALLETS) {
          const player = await prisma.player.findUnique({ where: { walletAddress: wallet } })
          if (player) {
            const lifetimeBefore = player.lifetimeTotalScore
            const weeklyAfter = player.weeklyScore
            const resetWeek = player.lastResetWeekNumber

            console.log(`   ${wallet.substring(0, 10)}...:`)
            console.log(`      Lifetime preserved: ${lifetimeBefore} ✅`)
            console.log(`      Weekly reset: ${weeklyAfter === 0 ? 'Yes' : `No (${weeklyAfter})`} ${weeklyAfter === 0 ? '✅' : '⚠️'}`)
            console.log(`      Reset week: ${resetWeek ?? 'null'}`)
          }
        }
      }
    }

    // Final summary
    console.log(`\n${'='.repeat(60)}`)
    console.log('📊 FINAL SUMMARY')
    console.log(`${'='.repeat(60)}\n`)

    for (const wallet of TEST_WALLETS) {
      const player = await prisma.player.findUnique({ where: { walletAddress: wallet } })
      if (player) {
        console.log(`\n👤 ${wallet.substring(0, 10)}...`)
        console.log(`   Final Lifetime Score: ${player.lifetimeTotalScore}`)
        console.log(`   Final Weekly Score: ${player.weeklyScore}`)
        console.log(`   Final Longest Streak: ${player.longestStreak}`)
        console.log(`   Final Current Streak: ${player.currentStreak}`)
        console.log(`   Last Reset Week: ${player.lastResetWeekNumber ?? 'null'}`)
      }
    }

    // Check snapshots
    const snapshotCount = await prisma.weeklyScoreSnapshot.count({
      where: { walletAddress: { in: TEST_WALLETS } },
    })
    console.log(`\n📸 Total snapshots created: ${snapshotCount}`)

    console.log(`\n✅ Simulation complete!`)
    
    // Disable secondsPerDay
    await prisma.gameSettings.update({
      where: { id: 1 },
      data: { secondsPerDay: null },
    })
    console.log('✅ Disabled fast time mode')
  } catch (error) {
    console.error('❌ Simulation failed:', error)
    try {
      await prisma.gameSettings.update({
        where: { id: 1 },
        data: { secondsPerDay: null },
      })
    } catch {}
    throw error
  } finally {
    await app.close()
    await prisma.$disconnect()
    await pool.end()
  }
}

main().catch(console.error)
