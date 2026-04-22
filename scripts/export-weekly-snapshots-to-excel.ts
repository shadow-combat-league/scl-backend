import { PrismaClient, Prisma } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import * as dotenv from 'dotenv'
import * as ExcelJS from 'exceljs'
import * as fs from 'fs'
import * as path from 'path'

dotenv.config()

let prisma: PrismaClient | null = null
let pool: Pool | null = null

type CliArgs = {
  databaseUrl?: string
  output?: string
  fromWeekNumber?: number
  toWeekNumber?: number
  latestWeeks?: number
  walletsFile?: string
}

function readArgs(argv: string[]): CliArgs {
  const args: CliArgs = {}

  const getValue = (name: keyof CliArgs): string | undefined => {
    const exact = argv.find(a => a === `--${String(name)}`)
    if (exact) {
      const idx = argv.indexOf(exact)
      return argv[idx + 1]
    }

    const withEquals = argv.find(a => a.startsWith(`--${String(name)}=`))
    if (!withEquals) return undefined
    return withEquals.split('=').slice(1).join('=')
  }

  const databaseUrl = getValue('databaseUrl')
  if (databaseUrl) args.databaseUrl = databaseUrl

  const output = getValue('output')
  if (output) args.output = output

  const fromWeekNumber = getValue('fromWeekNumber')
  if (fromWeekNumber) args.fromWeekNumber = Number(fromWeekNumber)

  const toWeekNumber = getValue('toWeekNumber')
  if (toWeekNumber) args.toWeekNumber = Number(toWeekNumber)

  const latestWeeks = getValue('latestWeeks')
  if (latestWeeks) args.latestWeeks = Number(latestWeeks)

  const walletsFile = getValue('walletsFile')
  if (walletsFile) args.walletsFile = walletsFile

  return args
}

function parseWalletsFile(filePath: string): string[] {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
  const raw = fs.readFileSync(abs, 'utf8')
  return raw
    .split(/\r?\n/g)
    .map(l => l.trim())
    .filter(Boolean)
}

async function main() {
  const args = readArgs(process.argv.slice(2))

  const runtimeDatabaseUrl = args.databaseUrl ?? process.env.DATABASE_URL
  if (!runtimeDatabaseUrl) {
    throw new Error('DATABASE_URL environment variable is required (or pass --databaseUrl)')
  }

  pool = new Pool({ connectionString: runtimeDatabaseUrl })
  const adapter = new PrismaPg(pool)
  prisma = new PrismaClient({ adapter })

  const defaultOutputDir = path.resolve(process.cwd(), 'exports')
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outputPath =
    args.output ??
    path.join(defaultOutputDir, `weekly-snapshots-and-lifetime-${timestamp}.xlsx`)

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  const walletAddresses: string[] | undefined = args.walletsFile
    ? parseWalletsFile(args.walletsFile)
    : undefined

  let fromWeekNumber = args.fromWeekNumber
  let toWeekNumber = args.toWeekNumber

  if (args.latestWeeks && (!fromWeekNumber || Number.isNaN(fromWeekNumber))) {
    const maxAgg = await prisma.weeklyScoreSnapshot.aggregate({
      _max: { weekNumber: true },
    })
    const maxWeekNumber = maxAgg._max.weekNumber
    if (maxWeekNumber === null || maxWeekNumber === undefined) {
      throw new Error('Cannot compute latest week range: no snapshots exist in the DB')
    }
    fromWeekNumber = maxWeekNumber - args.latestWeeks + 1
    toWeekNumber = maxWeekNumber
  }

  const weekNumberFilter: Prisma.IntFilter | undefined = (() => {
    const hasFrom = fromWeekNumber !== undefined && !Number.isNaN(fromWeekNumber)
    const hasTo = toWeekNumber !== undefined && !Number.isNaN(toWeekNumber)

    if (!hasFrom && !hasTo) return undefined
    if (hasFrom && hasTo) return { gte: fromWeekNumber, lte: toWeekNumber }
    if (hasFrom) return { gte: fromWeekNumber }
    return { lte: toWeekNumber }
  })()

  const snapshotWhere: Prisma.WeeklyScoreSnapshotWhereInput = {
    ...(walletAddresses ? { walletAddress: { in: walletAddresses } } : {}),
    ...(weekNumberFilter ? { weekNumber: weekNumberFilter } : {}),
  }

  if (!prisma) throw new Error('Prisma client not initialized')

  const totalSnapshots = await prisma.weeklyScoreSnapshot.count({ where: snapshotWhere })
  if (totalSnapshots > 1048575) {
    throw new Error(
      `Refusing to export ${totalSnapshots} snapshot rows (Excel row limit ~1,048,576). Narrow by --fromWeekNumber/--toWeekNumber or --walletsFile.`,
    )
  }

  const agg = await prisma.weeklyScoreSnapshot.aggregate({
    where: snapshotWhere,
    _min: { weekNumber: true },
    _sum: { lifetimeTotalScore: true },
    _max: { weekNumber: true, weeklyScore: true },
    _count: { _all: true },
  })

  const minWeekNumber = agg._min.weekNumber ?? null
  const maxWeekNumber = agg._max.weekNumber ?? null
  const sumLifetimeTotalScore = agg._sum.lifetimeTotalScore ?? 0
  const maxWeeklyScore = agg._max.weeklyScore ?? null

  // Stream workbook to avoid memory blowups on large datasets
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: outputPath,
    useStyles: false,
  })

  const summarySheet = workbook.addWorksheet('Summary')
  summarySheet.columns = [
    { width: 36 },
    { width: 40 },
  ]
  summarySheet.addRow(['Key', 'Value']).commit()
  summarySheet.addRow(['ExportedAt', new Date().toISOString()]).commit()
  summarySheet.addRow(['WalletFilter', walletAddresses ? `${walletAddresses.length} wallets` : 'ALL wallets']).commit()
  summarySheet
    .addRow([
      'WeekRange',
      minWeekNumber !== null && maxWeekNumber !== null ? `${minWeekNumber}..${maxWeekNumber}` : 'N/A',
    ])
    .commit()
  summarySheet.addRow(['SnapshotsCount', totalSnapshots]).commit()
  summarySheet.addRow(['SumLifetimeTotalScoreAtSnapshot', sumLifetimeTotalScore]).commit()
  summarySheet.addRow(['MaxWeeklyScore', maxWeeklyScore ?? '']).commit()

  const weekValues = await prisma.weeklyScoreSnapshot.findMany({
    where: snapshotWhere,
    select: { weekNumber: true },
    distinct: ['weekNumber'],
    orderBy: { weekNumber: 'desc' },
  })

  for (const { weekNumber } of weekValues) {
    const sheetName = `Week ${weekNumber}`
    const weekSheet = workbook.addWorksheet(sheetName)
    weekSheet.columns = [
      { width: 12 }, // weekNumber
      { width: 46 }, // walletAddress
      { width: 14 }, // weeklyScore
      { width: 14 }, // weeklyStreak
      { width: 20 }, // weeklyLongestStreak
      { width: 28 }, // lifetimeTotalScoreAtSnapshot
      { width: 24 }, // snapshotDate
    ]

    weekSheet
      .addRow([
        'weekNumber',
        'walletAddress',
        'weeklyScore',
        'weeklyStreak',
        'weeklyLongestStreak',
        'lifetimeTotalScoreAtSnapshot',
        'snapshotDate',
      ])
      .commit()

    const weekRows = await prisma.weeklyScoreSnapshot.findMany({
      where: { ...snapshotWhere, weekNumber },
      orderBy: [
        { weeklyScore: 'desc' },
        { lifetimeTotalScore: 'desc' },
        { weeklyStreak: 'desc' },
        { walletAddress: 'asc' },
        { snapshotDate: 'desc' },
      ],
    })

    for (const s of weekRows) {
      weekSheet
        .addRow([
          s.weekNumber,
          s.walletAddress,
          s.weeklyScore,
          s.weeklyStreak,
          s.weeklyLongestStreak,
          s.lifetimeTotalScore,
          s.snapshotDate.toISOString(),
        ])
        .commit()
    }
  }

  const lifetimeSheet = workbook.addWorksheet('LifetimeOverall')
  lifetimeSheet.columns = [
    { width: 46 }, // walletAddress
    { width: 42 }, // lifetimeTotalScore (reset-aware)
    { width: 40 }, // totalScore (running)
    { width: 12 }, // weeklyScore
    { width: 14 }, // currentStreak
    { width: 14 }, // longestStreak
    { width: 12 }, // weeklyStreak
    { width: 20 }, // weeklyLongestStreak
    { width: 20 }, // lastResetWeekNumber
  ]
  lifetimeSheet
    .addRow([
      'Notes',
      'lifetimeTotalScore = official lifetime score carried forward at weekly reset',
      'totalScore = running all-time score updated every game',
      '',
      '',
      '',
      '',
      '',
      '',
    ])
    .commit()
  lifetimeSheet.addRow([
    'walletAddress',
    'lifetimeTotalScore (weekly-reset official)',
    'totalScore (running per-game accumulator)',
    'weeklyScore',
    'currentStreak',
    'longestStreak',
    'weeklyStreak',
    'weeklyLongestStreak',
    'lastResetWeekNumber',
  ]).commit()

  const playerSelect: Prisma.PlayerSelect = {
    id: true, // used for cursor pagination
    walletAddress: true,
    lifetimeTotalScore: true,
    totalScore: true,
    weeklyScore: true,
    currentStreak: true,
    longestStreak: true,
    weeklyStreak: true,
    weeklyLongestStreak: true,
    lastResetWeekNumber: true,
  }

  const players = await prisma.player.findMany({
    select: playerSelect,
    where: {
      ...(walletAddresses ? { walletAddress: { in: walletAddresses } } : {}),
    },
    orderBy: [
      { lifetimeTotalScore: 'desc' },
      { weeklyScore: 'desc' },
      { walletAddress: 'asc' },
    ],
  })

  for (const p of players) {
    lifetimeSheet
      .addRow([
        p.walletAddress,
        p.lifetimeTotalScore,
        p.totalScore,
        p.weeklyScore,
        p.currentStreak,
        p.longestStreak,
        p.weeklyStreak,
        p.weeklyLongestStreak,
        p.lastResetWeekNumber ?? null,
      ])
      .commit()
  }

  await workbook.commit()

  console.log('✅ Excel export complete')
  console.log(`Output: ${outputPath}`)
}

main()
  .catch(err => {
    console.error('❌ Export failed')
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    if (prisma) await prisma.$disconnect()
    if (pool) await pool.end()
  })

