import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import * as dotenv from 'dotenv'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../src/app.module'
import { GameService } from '../src/game/game.service'
import { WeeklyResetService } from '../src/game/weekly-reset.service'
import { WordpressService } from '../src/wordpress/wordpress.service'

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

interface TestSnapshot {
  walletAddress: string
  weekNumber: number
  weeklyScore: number
  lifetimeTotalScore: number
  weeklyStreak: number
  longestStreak: number
  currentStreak: number
  lastResetWeekNumber: number | null
  timestamp: Date
}

const testSnapshots: Map<string, TestSnapshot[]> = new Map()

async function takeSnapshot(prisma: PrismaClient, walletAddress: string, weekNumber: number): Promise<void> {
  const player = await prisma.player.findUnique({ where: { walletAddress } })
  
  if (!player) {
    console.error(`❌ Player not found: ${walletAddress}`)
    return
  }

  const snapshot: TestSnapshot = {
    walletAddress,
    weekNumber,
    weeklyScore: player.weeklyScore,
    lifetimeTotalScore: player.lifetimeTotalScore,
    weeklyStreak: player.weeklyStreak,
    longestStreak: player.longestStreak,
    currentStreak: player.currentStreak,
    lastResetWeekNumber: player.lastResetWeekNumber,
    timestamp: new Date(),
  }

  if (!testSnapshots.has(walletAddress)) {
    testSnapshots.set(walletAddress, [])
  }
  testSnapshots.get(walletAddress)!.push(snapshot)

  console.log(`   📸 ${walletAddress.substring(0, 10)}...: Weekly=${snapshot.weeklyScore}, Lifetime=${snapshot.lifetimeTotalScore}, Streak=${snapshot.currentStreak}`)
}

async function main() {
  console.log('🚀 Starting 3-Week Weekly Reset Simulation Test (Mocked WordPress)')
  console.log('📝 This test mocks WordPress launch date to test real game logic\n')

  const app = await NestFactory.createApplicationContext(AppModule)
  const gameService = app.get(GameService)
  const weeklyResetService = app.get(WeeklyResetService)
  const wordpressService = app.get(WordpressService)

  // Mock WordPress service to return past launch date
  const mockLaunchDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days ago
  const originalGetGameSettings = wordpressService.getGameSettings.bind(wordpressService)
  
  // Clear cache first
  const cacheManager = (wordpressService as any).cacheManager
  await cacheManager.del('wp:game_settings')
  await cacheManager.del('game:settings')
  
  wordpressService.getGameSettings = async () => {
    // Return mocked data directly, bypassing cache and WordPress API
    return {
      launchDate: mockLaunchDate,
      dailyCheckInEnabled: false,
      dailyCheckInLaunchDate: null,
      gameState: 'ACTIVE' as const,
      weeklyResetEnabled: true,
      weeklyResetDay: 0, // Sunday
      weeklyResetHour: 1,
      weeklyResetMinute: 0,
    }
  }

  console.log(`📅 Mocked launch date: ${mockLaunchDate.toISOString()} (30 days ago)`)
  console.log('✅ WordPress service mocked - cache cleared\n')

  try {
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
          launchDate: mockLaunchDate, // Use mocked launch date
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
          console.log('   ⏳ Waiting 11 seconds (1 day)...')
          await new Promise(resolve => setTimeout(resolve, 11000))
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
        console.log('   📸 Daily snapshots:')
        for (const wallet of TEST_WALLETS) {
          await takeSnapshot(prisma, wallet, week)
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
          console.log(`      Longest Streak: ${player.longestStreak}`)
          console.log(`      Last Reset Week: ${player.lastResetWeekNumber ?? 'null'}`)
        }
      }

      // Check snapshots in database
      const dbSnapshots = await prisma.weeklyScoreSnapshot.findMany({
        where: { walletAddress: { in: TEST_WALLETS }, weekNumber: week },
        orderBy: { snapshotDate: 'asc' },
      })
      console.log(`\n   📸 Database snapshots for Week ${week}: ${dbSnapshots.length}`)
      if (dbSnapshots.length > 0) {
        dbSnapshots.forEach(snap => {
          console.log(`      ${snap.walletAddress.substring(0, 10)}...: Weekly=${snap.weeklyScore}, Lifetime=${snap.lifetimeTotalScore}`)
        })
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
        let allValid = true
        for (const wallet of TEST_WALLETS) {
          const player = await prisma.player.findUnique({ where: { walletAddress: wallet } })
          if (player) {
            const walletSnapshots = testSnapshots.get(wallet)?.filter(s => s.weekNumber === week) || []
            const lastSnapshot = walletSnapshots[walletSnapshots.length - 1]

            console.log(`\n   ${wallet.substring(0, 10)}...:`)
            
            if (lastSnapshot) {
              // Lifetime should never decrease
              if (player.lifetimeTotalScore < lastSnapshot.lifetimeTotalScore) {
                console.error(`      ❌ Lifetime score decreased! Was ${lastSnapshot.lifetimeTotalScore}, now ${player.lifetimeTotalScore}`)
                allValid = false
              } else {
                console.log(`      ✅ Lifetime preserved/increased: ${lastSnapshot.lifetimeTotalScore} → ${player.lifetimeTotalScore}`)
              }

              // Weekly should reset (but might have new scores already)
              const expectedLifetime = lastSnapshot.lifetimeTotalScore + lastSnapshot.weeklyScore
              if (Math.abs(player.lifetimeTotalScore - expectedLifetime) < 1000) { // Allow for new scores
                console.log(`      ✅ Lifetime includes weekly score: ${expectedLifetime} ≈ ${player.lifetimeTotalScore}`)
              } else {
                console.log(`      ⚠️  Lifetime difference: expected ~${expectedLifetime}, got ${player.lifetimeTotalScore}`)
              }

              // Weekly should be reset or have new scores
              if (player.lastResetWeekNumber === week + 1) {
                console.log(`      ✅ Weekly reset confirmed (lastResetWeekNumber = ${week + 1})`)
              } else {
                console.log(`      ⚠️  Weekly reset week: ${player.lastResetWeekNumber} (expected ${week + 1})`)
              }
            }
          }
        }

        if (allValid) {
          console.log(`\n✅ Week transition ${week} → ${week + 1} validated successfully`)
        } else {
          console.error(`\n❌ Validation failed for week transition ${week} → ${week + 1}`)
        }
      }
    }

    // Final summary
    console.log(`\n${'='.repeat(60)}`)
    console.log('📊 FINAL SUMMARY')
    console.log(`${'='.repeat(60)}\n`)

    for (const wallet of TEST_WALLETS) {
      const player = await prisma.player.findUnique({ where: { walletAddress: wallet } })
      const walletSnapshots = testSnapshots.get(wallet) || []
      
      console.log(`\n👤 ${wallet.substring(0, 10)}...`)
      console.log(`   Final Lifetime Score: ${player?.lifetimeTotalScore ?? 0}`)
      console.log(`   Final Weekly Score: ${player?.weeklyScore ?? 0}`)
      console.log(`   Final Longest Streak: ${player?.longestStreak ?? 0}`)
      console.log(`   Final Current Streak: ${player?.currentStreak ?? 0}`)
      console.log(`   Last Reset Week: ${player?.lastResetWeekNumber ?? 'null'}`)
      console.log(`   Total Test Snapshots: ${walletSnapshots.length}`)
      
      // Show score progression
      console.log(`   Score Progression:`)
      walletSnapshots.forEach((snap, idx) => {
        console.log(`      Week ${snap.weekNumber} (snapshot ${idx + 1}): Weekly=${snap.weeklyScore}, Lifetime=${snap.lifetimeTotalScore}, Streak=${snap.currentStreak}`)
      })
    }

    // Check all database snapshots
    const allDbSnapshots = await prisma.weeklyScoreSnapshot.findMany({
      where: { walletAddress: { in: TEST_WALLETS } },
      orderBy: [{ weekNumber: 'asc' }, { snapshotDate: 'asc' }],
    })
    console.log(`\n📸 Total database snapshots: ${allDbSnapshots.length}`)
    console.log(`   Snapshots by week:`)
    const snapshotsByWeek = new Map<number, number>()
    allDbSnapshots.forEach(snap => {
      const count = snapshotsByWeek.get(snap.weekNumber) || 0
      snapshotsByWeek.set(snap.weekNumber, count + 1)
    })
    snapshotsByWeek.forEach((count, week) => {
      console.log(`      Week ${week}: ${count} snapshot(s)`)
    })

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
