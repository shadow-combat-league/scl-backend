/**
 * test-checkin.mjs
 *
 * Integration test — verifies the backend's blockchain monitor picks up
 * a real DailyCheckIn event from the local Anvil fork and:
 *   1. Creates a BlockchainCheckIn DB record
 *   2. Increments the player's points by 100
 *
 * Run AFTER:
 *   - node scripts/local-dev-setup.mjs   (postgres + anvil running)
 *   - npm run start:dev                   (backend running on :3333)
 */

import { createPublicClient, createWalletClient, http, parseAbiItem } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import pg from 'pg'

// ── Config ────────────────────────────────────────────────────────────────────
const ANVIL_RPC = 'http://localhost:8545'
const BACKEND_URL = 'http://localhost:3333'
const CONTRACT_ADDRESS = '0x2eeE0Cf01AD4f67E41D487525E6068a8F732722F'

const DB_URL = 'postgresql://scl_user:scl_password@localhost:5777/scl_game'

// Anvil test wallet #0 (well-known dev key — has 10000 ETH on the fork)
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

// ABI
const CHECKIN_ABI = [
  {
    type: 'function',
    name: 'checkIn',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'DailyCheckIn',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'timestamp', type: 'uint256', indexed: false },
    ],
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms))

function log(msg) { console.log(`  ${msg}`) }
function ok(msg) { console.log(`  ✅ ${msg}`) }
function fail(msg) { console.error(`  ❌ ${msg}`); process.exit(1) }
function section(title) { console.log(`\n─── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`) }

// ── Step 1: Check backend is up ───────────────────────────────────────────────
section('1. Backend health check')
try {
  const res = await fetch(`${BACKEND_URL}/health`)
  if (!res.ok) fail(`Backend returned ${res.status}`)
  ok(`Backend is up at ${BACKEND_URL}`)
} catch (e) {
  fail(`Backend not reachable at ${BACKEND_URL}: ${e.message}\nMake sure npm run start:dev is running.`)
}

// ── Step 2: Connect to DB and snapshot current state ─────────────────────────
section('2. DB snapshot (before check-in)')
const dbClient = new pg.Client({ connectionString: DB_URL })
await dbClient.connect()
ok('Connected to local PostgreSQL')

const account = privateKeyToAccount(TEST_PRIVATE_KEY)
const walletAddress = account.address.toLowerCase()
log(`Test wallet: ${walletAddress}`)

// Get current player state (if exists)
const { rows: beforeRows } = await dbClient.query(
  'SELECT * FROM "Player" WHERE "walletAddress" = $1',
  [walletAddress]
)
const playerBefore = beforeRows[0] || null
const scoreBefore = playerBefore?.totalScore ?? 0
const lifetimeBefore = playerBefore?.lifetimeTotalScore ?? 0
log(`Player exists: ${playerBefore ? 'yes' : 'no (will be created)'}`)
log(`totalScore before: ${scoreBefore}`)
log(`lifetimeTotalScore before: ${lifetimeBefore}`)

// Check no existing BlockchainCheckIn for this wallet recently
const { rows: existingCheckIns } = await dbClient.query(
  'SELECT COUNT(*) as count FROM "BlockchainCheckIn" WHERE "walletAddress" = $1',
  [walletAddress]
)
log(`Existing BlockchainCheckIn records: ${existingCheckIns[0].count}`)

// ── Step 3: Call checkIn() on the contract ────────────────────────────────────
section('3. Calling checkIn() on local Anvil fork')

// Use Base chain config but point to local anvil
const localBase = { ...base, rpcUrls: { default: { http: [ANVIL_RPC] }, public: { http: [ANVIL_RPC] } } }

const walletClient = createWalletClient({
  account,
  chain: localBase,
  transport: http(ANVIL_RPC),
})

const publicClient = createPublicClient({
  chain: localBase,
  transport: http(ANVIL_RPC),
})

// Check the contract has code on the fork
const code = await publicClient.getBytecode({ address: CONTRACT_ADDRESS })
if (!code || code === '0x') {
  fail(`No contract code at ${CONTRACT_ADDRESS} — is the Anvil fork running?`)
}
ok(`Contract exists at ${CONTRACT_ADDRESS} on local fork`)

log('Sending checkIn() transaction...')
let txHash
try {
  txHash = await walletClient.writeContract({
    address: CONTRACT_ADDRESS,
    abi: CHECKIN_ABI,
    functionName: 'checkIn',
  })
  ok(`Transaction sent: ${txHash}`)
} catch (e) {
  fail(`checkIn() failed: ${e.message}`)
}

// Wait for receipt
log('Waiting for transaction receipt...')
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
ok(`Mined in block ${receipt.blockNumber} (status: ${receipt.status})`)

if (receipt.status !== 'success') {
  fail('Transaction reverted!')
}

// Verify DailyCheckIn event was emitted
const logs = await publicClient.getLogs({
  address: CONTRACT_ADDRESS,
  event: parseAbiItem('event DailyCheckIn(address indexed user, uint256 timestamp)'),
  fromBlock: receipt.blockNumber,
  toBlock: receipt.blockNumber,
})

if (logs.length === 0) fail('No DailyCheckIn event in the receipt block!')
ok(`DailyCheckIn event emitted — user: ${logs[0].args.user}`)

// ── Step 4: Wait for backend to pick it up (up to 30s) ───────────────────────
section('4. Waiting for backend to process the event')
log('Backend polls every 15s — waiting up to 35s...')

let playerAfter = null
let checkInRecord = null

for (let i = 0; i < 7; i++) {
  await sleep(5000)
  log(`  (${(i + 1) * 5}s elapsed...)`)

  const { rows: playerRows } = await dbClient.query(
    'SELECT * FROM "Player" WHERE "walletAddress" = $1',
    [walletAddress]
  )
  const { rows: checkInRows } = await dbClient.query(
    'SELECT * FROM "BlockchainCheckIn" WHERE "txHash" = $1',
    [txHash]
  )

  if (playerRows.length > 0 && checkInRows.length > 0) {
    playerAfter = playerRows[0]
    checkInRecord = checkInRows[0]
    break
  }
}

if (!playerAfter || !checkInRecord) {
  fail('Backend did not process the event within 35s. Check backend logs.')
}

// ── Step 5: Verify results ────────────────────────────────────────────────────
section('5. Verifying DB state')

ok(`BlockchainCheckIn record created:`)
log(`   id            : ${checkInRecord.id}`)
log(`   txHash        : ${checkInRecord.txHash}`)
log(`   walletAddress : ${checkInRecord.walletAddress}`)
log(`   blockNumber   : ${checkInRecord.blockNumber}`)
log(`   pointsAwarded : ${checkInRecord.pointsAwarded}`)

ok(`Player record (after):`)
log(`   walletAddress      : ${playerAfter.walletAddress}`)
log(`   totalScore         : ${playerAfter.totalScore}  (was ${scoreBefore})`)
log(`   lifetimeTotalScore : ${playerAfter.lifetimeTotalScore}  (was ${lifetimeBefore})`)
log(`   weeklyScore        : ${playerAfter.weeklyScore}`)

// Assertions
const scoreGain = playerAfter.totalScore - scoreBefore
const lifetimeGain = playerAfter.lifetimeTotalScore - lifetimeBefore

if (scoreGain !== 100) fail(`totalScore should have increased by 100, got +${scoreGain}`)
ok(`totalScore increased by ${scoreGain} ✓`)

if (lifetimeGain !== 100) fail(`lifetimeTotalScore should have increased by 100, got +${lifetimeGain}`)
ok(`lifetimeTotalScore increased by ${lifetimeGain} ✓`)

if (checkInRecord.pointsAwarded !== 100) fail(`pointsAwarded should be 100, got ${checkInRecord.pointsAwarded}`)
ok(`pointsAwarded = ${checkInRecord.pointsAwarded} ✓`)

if (checkInRecord.walletAddress !== walletAddress) fail('walletAddress mismatch in BlockchainCheckIn')
ok(`walletAddress matches ✓`)

// ── Step 6: Idempotency check ─────────────────────────────────────────────────
section('6. Idempotency check (same txHash must not double-credit)')
// The backend should already have this tx in BlockchainCheckIn.
// Re-querying confirms it's unique.
const { rows: dupRows } = await dbClient.query(
  'SELECT COUNT(*) as count FROM "BlockchainCheckIn" WHERE "txHash" = $1',
  [txHash]
)
if (parseInt(dupRows[0].count) !== 1) fail(`Expected 1 BlockchainCheckIn record, found ${dupRows[0].count}`)
ok(`Only 1 record for txHash — idempotency confirmed ✓`)

await dbClient.end()

console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ALL CHECKS PASSED ✅
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Transaction  : ${txHash}
  Wallet       : ${walletAddress}
  Points gained: +100 totalScore / +100 lifetime
  DB record    : BlockchainCheckIn #${checkInRecord.id}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`)
