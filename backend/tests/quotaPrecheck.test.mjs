// BE-07/BE-08: QuotaGuard precheck + Retry-After parsing.
// Fixture logs gần chạm RPD → percentUsed ≥ 80 và precheck trả warning
// quota_risk (không chặn job: allowed=true). Provider không RPD → không warn.
// Run: node tests/quotaPrecheck.test.mjs
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_precheck_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { run } = await import('../src/db/query.js')
const { getQuotaSnapshot, precheckStage } = await import('../src/services/quotaGuardService.js')
const { parseRetryAfter, getNextRetryAt } = await import('../src/pipeline/runner.js')

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const userId = randomUUID()
const projectId = randomUUID()
await run(`INSERT INTO users (id, email, password) VALUES (?, ?, ?)`, [userId, `${userId}@t.co`, 'x'])
await run(`INSERT INTO projects (id, user_id, mode, title, status) VALUES (?, ?, 'TRANSLATE_DUB', 'pre', 'pending')`, [projectId, userId])
// Per-user limit nhỏ để fixture nhẹ: RPD=10 (thay vì seed 250 của gemini).
await run(
  `INSERT INTO provider_rate_limits (id, provider, tier, requests_per_minute, requests_per_day, concurrency, user_id) VALUES (?, 'pretest', 'custom', 10, 10, 1, ?)`,
  [randomUUID(), userId]
)

async function seedLogs(n, provider = 'pretest') {
  for (let i = 0; i < n; i++) {
    await run(
      `INSERT INTO provider_logs (id, project_id, provider, type, status) VALUES (?, ?, ?, 'llm', 'ok')`,
      [randomUUID(), projectId, provider]
    )
  }
}

// 1. Dưới ngưỡng → không warning, job vẫn allowed.
{
  const pre = await precheckStage(userId, 'pretest', 10)
  assert(pre.allowed === true && pre.warning === null, 'dưới ngưỡng → allowed, không warning')
}

// 2. Fixture 9/10 RPD (90%) → percentUsed ≥ 80 và warning quota_risk.
{
  await seedLogs(9)
  const snap = await getQuotaSnapshot(userId, 'pretest')
  assert(snap.percentUsed >= 80, `percentUsed ≥ 80 (got ${snap.percentUsed})`)
  const pre = await precheckStage(userId, 'pretest', 10)
  assert(pre.allowed === true, 'precheck không chặn job (allowed=true)')
  assert(pre.warning?.type === 'quota_risk', `warning type quota_risk (got ${pre.warning?.type})`)
  assert(pre.warning?.provider === 'pretest', 'warning mang đúng provider')
  assert(Number.isFinite(pre.warning?.estimatedShortfall) && pre.warning.estimatedShortfall > 0, `shortfall dương (got ${pre.warning?.estimatedShortfall})`)
}

// 3. Provider không RPD (elevenlabs seed RPD null) → không warning.
{
  await seedLogs(5, 'elevenlabs')
  const pre = await precheckStage(userId, 'elevenlabs', 10)
  assert(pre.allowed === true && pre.warning === null, 'không RPD → không warning')
}

// 4. BE-08: parseRetryAfter ưu tiên structured field, fallback message.
{
  assert(parseRetryAfter({ message: '429 Retry-After: 120' }) === 120, 'parse message Retry-After: 120')
  assert(parseRetryAfter({ retryAfter: 45, message: '429' }) === 45, 'ưu tiên err.retryAfter=45')
  assert(parseRetryAfter({ headers: { 'retry-after': '30' } }) === 30, "đọc headers['retry-after']=30")
  assert(parseRetryAfter(new Error('boom')) === null, 'không tín hiệu → null')
}

// 5. BE-08: getNextRetryAt fallback ≈ now + 60s.
{
  const before = Date.now()
  const iso = await getNextRetryAt('unknown-provider')
  const dt = new Date(iso).getTime() - before
  assert(dt >= 59_000 && dt <= 61_000, `fallback now+60s (dt=${dt}ms)`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
