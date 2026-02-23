import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import * as dotenv from 'dotenv'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../src/app.module'
import { GameService } from '../src/game/game.service'
import { WeeklyResetService } from '../src/game/weekly-reset.service'
import { SubmitScoreDto } from '../src/game/dto/submit-score.dto'

// Load environment variables
dotenv.config()

// Initialize PrismaClient with PostgreSQL adapter
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required')
}

const pool = new Pool({ connectionString: databaseUrl })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

// Test wallet addresses (42 chars max: 0x + 40 hex chars)
const TEST_WALLETS = [
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
  '0x3333333333333333333333333333333333333333',
]

interface PlayerSnapshot {
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

const snapshots: Map<string, PlayerSnapshot[]> = new Map()

function getRandomScore(): number {
  // Random score between 100 and 10000
  return Math.floor(Math.random() * 9900) + 100
}

async function takeSnapshot(
  prisma: PrismaClient,
  walletAddress: string,
  weekNumber: number
): Promise<void> {
  const player = await prisma.player.findUnique({ where: { walletAddress } })
  
  if (!player) {
    console.error(`❌ Player not found: ${walletAddress}`)
    return
  }

  const snapshot: PlayerSnapshot = {
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

  if (!snapshots.has(walletAddress)) {
    snapshots.set(walletAddress, [])
  }
  snapshots.get(walletAddress)!.push(snapshot)

  console.log(`📸 Snapshot for ${walletAddress.substring(0, 10)}... Week ${weekNumber}:`)
  console.log(`   Weekly Score: ${snapshot.weeklyScore}`)
  console.log(`   Lifetime Score: ${snapshot.lifetimeTotalScore}`)
  console.log(`   Weekly Streak: ${snapshot.weeklyStreak}`)
  console.log(`   Current Streak: ${snapshot.currentStreak}`)
  console.log(`   Last Reset Week: ${snapshot.lastResetWeekNumber ?? 'null'}`)
}

async function simulateWeek(
  gameService: GameService,
  prisma: PrismaClient,
  weekNumber: number
): Promise<void> {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`📅 WEEK ${weekNumber} - Starting simulation`)
  console.log(`${'='.repeat(60)}\n`)

  const settings = await prisma.gameSettings.findUnique({ where: { id: 1 } })
  console.log(`Current week number in DB: ${settings?.currentWeekNumber ?? 'null'}`)

  // Enable secondsPerDay for faster simulation (1 minute = 1 day)
  await prisma.gameSettings.update({
    where: { id: 1 },
    data: { secondsPerDay: 60 }, // 1 minute = 1 day for testing
  })
  console.log('✅ Enabled fast time mode: 1 minute = 1 day\n')

  // Simulate gameplay throughout the week
  // Day 0 (Sunday) - Start of week
  console.log(`\n🌅 Day 0 (Sunday) - Start of week ${weekNumber}`)
  for (const wallet of TEST_WALLETS) {
    const score = getRandomScore()
    console.log(`   ${wallet.substring(0, 10)}... submitting score: ${score}`)
    try {
      await gameService.submitScore({ walletAddress: wallet, score })
    } catch (error: any) {
      console.error(`   ❌ Error: ${error.message}`)
    }
  }
  await takeSnapshot(prisma, TEST_WALLETS[0], weekNumber)

  // Day 1-3 (Monday-Wednesday) - Mid week
  // Wait 1 minute (1 day) between each day
  for (let day = 1; day <= 3; day++) {
    console.log(`\n🌆 Day ${day} (${['Monday', 'Tuesday', 'Wednesday'][day - 1]})`)
    // Wait for next day (1 minute = 1 day in test mode)
    await new Promise(resolve => setTimeout(resolve, 61000)) // 61 seconds to ensure next day
    
    for (const wallet of TEST_WALLETS) {
      if (Math.random() > 0.3) { // 70% chance to play
        const score = getRandomScore()
        console.log(`   ${wallet.substring(0, 10)}... submitting score: ${score}`)
        try {
          await gameService.submitScore({ walletAddress: wallet, score })
        } catch (error: any) {
          console.error(`   ❌ Error: ${error.message}`)
        }
      }
    }
  }
  await takeSnapshot(prisma, TEST_WALLETS[0], weekNumber)

  // Day 4-6 (Thursday-Saturday) - End of week
  for (let day = 4; day <= 6; day++) {
    console.log(`\n🌃 Day ${day} (${['Thursday', 'Friday', 'Saturday'][day - 4]})`)
    // Wait for next day
    await new Promise(resolve => setTimeout(resolve, 61000)) // 61 seconds to ensure next day
    
    for (const wallet of TEST_WALLETS) {
      if (Math.random() > 0.3) { // 70% chance to play
        const score = getRandomScore()
        console.log(`   ${wallet.substring(0, 10)}... submitting score: ${score}`)
        try {
          await gameService.submitScore({ walletAddress: wallet, score })
        } catch (error: any) {
          console.error(`   ❌ Error: ${error.message}`)
        }
      }
    }
  }

  // Final snapshot before reset
  console.log(`\n📊 End of Week ${weekNumber} - Final snapshot`)
  for (const wallet of TEST_WALLETS) {
    await takeSnapshot(prisma, wallet, weekNumber)
  }

  // Get final statuses
  console.log(`\n📈 Final Statuses for Week ${weekNumber}:`)
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
}

async function verifyWeekTransition(
  prisma: PrismaClient,
  previousWeek: number,
  currentWeek: number
): Promise<boolean> {
  console.log(`\n🔍 Verifying transition from Week ${previousWeek} to Week ${currentWeek}`)
  
  let allValid = true

  for (const wallet of TEST_WALLETS) {
    const player = await prisma.player.findUnique({ where: { walletAddress: wallet } })
    if (!player) {
      console.error(`❌ Player not found: ${wallet}`)
      allValid = false
      continue
    }

    const previousSnapshots = snapshots.get(wallet)?.filter(s => s.weekNumber === previousWeek) || []
    const lastSnapshot = previousSnapshots[previousSnapshots.length - 1]

    if (lastSnapshot) {
      console.log(`\n   Checking ${wallet.substring(0, 10)}...:`)
      
      // Lifetime score should never decrease
      if (player.lifetimeTotalScore < lastSnapshot.lifetimeTotalScore) {
        console.error(`   ❌ Lifetime score decreased! Was ${lastSnapshot.lifetimeTotalScore}, now ${player.lifetimeTotalScore}`)
        allValid = false
      } else {
        console.log(`   ✅ Lifetime score maintained/increased: ${lastSnapshot.lifetimeTotalScore} → ${player.lifetimeTotalScore}`)
      }

      // Weekly score should reset if week changed
      if (currentWeek > previousWeek) {
        if (player.lastResetWeekNumber === currentWeek) {
          console.log(`   ✅ Weekly score reset (lastResetWeekNumber = ${currentWeek})`)
          if (player.weeklyScore > 0) {
            console.log(`   ℹ️  Weekly score is ${player.weeklyScore} (new week, new scores)`)
          }
        } else if (player.lastResetWeekNumber === previousWeek) {
          console.log(`   ⚠️  Weekly score not reset yet (lastResetWeekNumber = ${previousWeek})`)
        }
      }

      // Longest streak should never decrease
      if (player.longestStreak < lastSnapshot.longestStreak) {
        console.error(`   ❌ Longest streak decreased! Was ${lastSnapshot.longestStreak}, now ${player.longestStreak}`)
        allValid = false
      } else {
        console.log(`   ✅ Longest streak maintained/increased: ${lastSnapshot.longestStreak} → ${player.longestStreak}`)
      }
    }
  }

  return allValid
}

async function main() {
  console.log('🚀 Starting 3-Week Weekly Reset Simulation Test')
  console.log(`Database: ${databaseUrl.split('@')[1] || 'connected'}\n`)

  // Initialize NestJS app to get services
  const app = await NestFactory.createApplicationContext(AppModule)
  const gameService = app.get(GameService)
  const weeklyResetService = app.get(WeeklyResetService)

  try {
    // Get initial settings
    const settings = await prisma.gameSettings.findUnique({ where: { id: 1 } })
    console.log('📋 Initial Game Settings:')
    console.log(`   Current Week Number: ${settings?.currentWeekNumber ?? 'null'}\n`)

    // Temporarily set launch date to past for testing (7 days ago)
    const wpSettings = await gameService.getSettings()
    const testLaunchDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 7 days ago
    console.log(`📅 Setting test launch date to: ${testLaunchDate.toISOString()} (7 days ago)`)
    console.log(`   This allows players to have multiple plays for testing\n`)

    // Clear any existing test players
    console.log('🧹 Cleaning up existing test players...')
    for (const wallet of TEST_WALLETS) {
      await prisma.player.deleteMany({ where: { walletAddress: wallet } })
      // Create players with past launch date so they have plays available
      await prisma.player.create({
        data: {
          walletAddress: wallet,
          launchDate: testLaunchDate, // Use past date so players have plays
          totalScore: 0,
          currentStreak: 0,
          longestStreak: 0,
          lifetimeTotalScore: 0,
          weeklyScore: 0,
          weeklyStreak: 0,
          weeklyLongestStreak: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      })
    }
    console.log('✅ Test players cleaned up and recreated with past launch date\n')

    // Simulate 3 weeks
    for (let week = 0; week < 3; week++) {
      const currentWeek = await getCurrentWeekNumber(prisma)
      await simulateWeek(gameService, prisma, currentWeek)

      // Trigger weekly reset (simulate moving to next week)
      if (week < 2) { // Don't reset after last week
        console.log(`\n🔄 Triggering weekly reset to move to Week ${currentWeek + 1}...`)
        
        // Manually update week number to simulate reset
        await prisma.gameSettings.update({
          where: { id: 1 },
          data: { currentWeekNumber: currentWeek + 1 },
        })

        // Trigger the actual reset logic
        await weeklyResetService.checkAndPerformReset()
        await new Promise(resolve => setTimeout(resolve, 1000)) // Wait for reset to process

        const newWeek = await getCurrentWeekNumber(prisma)
        console.log(`✅ Week number updated: ${currentWeek} → ${newWeek}`)

        // Verify the transition
        const isValid = await verifyWeekTransition(prisma, currentWeek, newWeek)
        if (!isValid) {
          console.error(`\n❌ Validation failed for week transition ${currentWeek} → ${newWeek}`)
        } else {
          console.log(`\n✅ Week transition ${currentWeek} → ${newWeek} validated successfully`)
        }
      }
    }

    // Final summary
    console.log(`\n${'='.repeat(60)}`)
    console.log('📊 FINAL SUMMARY')
    console.log(`${'='.repeat(60)}\n`)

    for (const wallet of TEST_WALLETS) {
      const player = await prisma.player.findUnique({ where: { walletAddress: wallet } })
      const walletSnapshots = snapshots.get(wallet) || []
      
      console.log(`\n👤 ${wallet.substring(0, 10)}...`)
      console.log(`   Final Lifetime Score: ${player?.lifetimeTotalScore ?? 0}`)
      console.log(`   Final Weekly Score: ${player?.weeklyScore ?? 0}`)
      console.log(`   Final Longest Streak: ${player?.longestStreak ?? 0}`)
      console.log(`   Final Current Streak: ${player?.currentStreak ?? 0}`)
      console.log(`   Last Reset Week: ${player?.lastResetWeekNumber ?? 'null'}`)
      console.log(`   Total Snapshots: ${walletSnapshots.length}`)
      
      // Show score progression
      console.log(`   Score Progression:`)
      walletSnapshots.forEach((snap, idx) => {
        console.log(`      Week ${snap.weekNumber} (snapshot ${idx + 1}): Weekly=${snap.weeklyScore}, Lifetime=${snap.lifetimeTotalScore}`)
      })
    }

    console.log(`\n✅ Simulation complete!`)
    
    // Disable secondsPerDay to return to normal mode
    await prisma.gameSettings.update({
      where: { id: 1 },
      data: { secondsPerDay: null },
    })
    console.log('✅ Disabled fast time mode (returned to normal)')
  } catch (error) {
    console.error('❌ Simulation failed:', error)
    // Try to disable secondsPerDay even on error
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

async function getCurrentWeekNumber(prisma: PrismaClient): Promise<number> {
  const settings = await prisma.gameSettings.findUnique({ where: { id: 1 } })
  return settings?.currentWeekNumber ?? 0
}

main().catch(console.error)
