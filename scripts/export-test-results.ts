import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import * as dotenv from 'dotenv'

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

async function main() {
  console.log('📊 Exporting Weekly Snapshots and Lifetime Scores\n')
  console.log('='.repeat(80))

  // Get all weekly snapshots
  const snapshots = await prisma.weeklyScoreSnapshot.findMany({
    where: { walletAddress: { in: TEST_WALLETS } },
    orderBy: [{ walletAddress: 'asc' }, { weekNumber: 'asc' }, { snapshotDate: 'asc' }],
  })

  console.log(`\n📸 WEEKLY SNAPSHOTS (${snapshots.length} total)\n`)
  console.log('-'.repeat(80))

  // Group by wallet
  const snapshotsByWallet = new Map<string, typeof snapshots>()
  for (const wallet of TEST_WALLETS) {
    snapshotsByWallet.set(wallet, snapshots.filter(s => s.walletAddress === wallet))
  }

  for (const wallet of TEST_WALLETS) {
    const walletSnapshots = snapshotsByWallet.get(wallet) || []
    if (walletSnapshots.length === 0) continue

    console.log(`\n👤 ${wallet.substring(0, 10)}... (${wallet})`)
    console.log(`   Total Snapshots: ${walletSnapshots.length}`)
    console.log(`\n   Week | Weekly Score | Weekly Streak | Weekly Longest | Lifetime Total | Snapshot Date`)
    console.log(`   ${'-'.repeat(75)}`)

    for (const snap of walletSnapshots) {
      const date = new Date(snap.snapshotDate).toISOString().replace('T', ' ').substring(0, 19)
      console.log(
        `   ${String(snap.weekNumber).padStart(4)} | ${String(snap.weeklyScore).padStart(12)} | ${String(snap.weeklyStreak).padStart(13)} | ${String(snap.weeklyLongestStreak).padStart(15)} | ${String(snap.lifetimeTotalScore).padStart(14)} | ${date}`
      )
    }
  }

  // Get current player states
  console.log(`\n${'='.repeat(80)}`)
  console.log(`\n👥 CURRENT PLAYER STATES\n`)
  console.log('-'.repeat(80))

  for (const wallet of TEST_WALLETS) {
    const player = await prisma.player.findUnique({ where: { walletAddress: wallet } })
    if (player) {
      console.log(`\n👤 ${wallet.substring(0, 10)}... (${wallet})`)
      console.log(`   Lifetime Total Score: ${player.lifetimeTotalScore}`)
      console.log(`   Weekly Score: ${player.weeklyScore}`)
      console.log(`   Current Streak: ${player.currentStreak}`)
      console.log(`   Longest Streak: ${player.longestStreak}`)
      console.log(`   Weekly Streak: ${player.weeklyStreak}`)
      console.log(`   Weekly Longest Streak: ${player.weeklyLongestStreak}`)
      console.log(`   Last Reset Week Number: ${player.lastResetWeekNumber ?? 'null'}`)
      console.log(`   Launch Date: ${player.launchDate?.toISOString() ?? 'null'}`)
    }
  }

  // Summary statistics
  console.log(`\n${'='.repeat(80)}`)
  console.log(`\n📈 SUMMARY STATISTICS\n`)
  console.log('-'.repeat(80))

  const totalSnapshots = snapshots.length
  const uniqueWeeks = new Set(snapshots.map(s => s.weekNumber)).size
  const totalLifetimeScore = snapshots.reduce((sum, s) => sum + s.lifetimeTotalScore, 0)
  const maxLifetimeScore = Math.max(...snapshots.map(s => s.lifetimeTotalScore), 0)
  const maxWeeklyScore = Math.max(...snapshots.map(s => s.weeklyScore), 0)

  console.log(`\n   Total Snapshots: ${totalSnapshots}`)
  console.log(`   Unique Weeks: ${uniqueWeeks}`)
  console.log(`   Total Lifetime Score (sum): ${totalLifetimeScore}`)
  console.log(`   Max Lifetime Score: ${maxLifetimeScore}`)
  console.log(`   Max Weekly Score: ${maxWeeklyScore}`)

  // Export as JSON
  console.log(`\n${'='.repeat(80)}`)
  console.log(`\n📄 JSON EXPORT\n`)
  console.log('-'.repeat(80))
  console.log(JSON.stringify({
    snapshots: snapshots.map(s => ({
      id: s.id,
      weekNumber: s.weekNumber,
      walletAddress: s.walletAddress,
      weeklyScore: s.weeklyScore,
      weeklyStreak: s.weeklyStreak,
      weeklyLongestStreak: s.weeklyLongestStreak,
      lifetimeTotalScore: s.lifetimeTotalScore,
      snapshotDate: s.snapshotDate.toISOString(),
    })),
    players: await Promise.all(
      TEST_WALLETS.map(async wallet => {
        const player = await prisma.player.findUnique({ where: { walletAddress: wallet } })
        if (!player) return null
        return {
          walletAddress: player.walletAddress,
          lifetimeTotalScore: player.lifetimeTotalScore,
          weeklyScore: player.weeklyScore,
          currentStreak: player.currentStreak,
          longestStreak: player.longestStreak,
          weeklyStreak: player.weeklyStreak,
          weeklyLongestStreak: player.weeklyLongestStreak,
          lastResetWeekNumber: player.lastResetWeekNumber,
          launchDate: player.launchDate?.toISOString() ?? null,
        }
      })
    ).then(results => results.filter(p => p !== null)),
  }, null, 2))

  console.log(`\n${'='.repeat(80)}`)
  console.log(`\n✅ Export complete!\n`)
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
