// BE-Q03: quota accounting semantics (§4.1-4.3, §6 items 1-5).
// Quota usage = successful external requests ONLY (ok/success). cache_hit,
// quota_exceeded, rate_limited, transient, error đều KHÔNG tính.
// Run: node tests/quotaAccounting.test.mjs
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_acct_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { run } = await import('../src/db/query.js')
const { getQuotaSnapshot, isQuotaCountingProviderLog, checkQuotaWarning, precheckStage } = await import('../src/services/quotaGuardService.js')

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// helper unit cho từng status (không ambiguity — §6 item 4 một phần).
{
  assert(isQuotaCountingProviderLog('ok') === true, 'ok → counts')
  assert(isQuotaCountingProviderLog('success') === true, 'success (legacy) → counts')
  assert(isQuotaCountingProviderLog('cache_hit') === false, 'cache_hit → +0 (provider không được gọi)')
  assert(isQuotaCountingProviderLog('quota_exceeded') === false, 'quota_exceeded → +0 (bị từ chối, không consumption)')
  assert(isQuotaCountingProviderLog('rate_limited') === false, 'rate_limited → +0 (bị throttle, retry thành công mới tính)')
  assert(isQuotaCountingProviderLog('transient') === false, 'transient → +0')
  assert(isQuotaCountingProviderLog('error') === false, 'error → +0')
  assert(isQuotaCountingProviderLog(null) === false, 'null → +0')
  assert(isQuotaCountingProviderLog('') === false, 'empty → +0')
  assert(isQuotaCountingProviderLog('OK') === true, 'case-insensitive OK → counts')
}

const userId = randomUUID()
const projectId = randomUUID()
await run(`INSERT INTO users (id, email, password) VALUES (?, ?, ?)`, [userId, `${userId}@t.co`, 'x'])
await run(`INSERT INTO projects (id, user_id, mode, title, status) VALUES (?, ?, 'TRANSLATE_DUB', 'acct', 'pending')`, [projectId, userId])
await run(
  `INSERT INTO provider_rate_limits (id, provider, tier, requests_per_minute, requests_per_day, concurrency, user_id) VALUES (?, 'acctest', 'custom', 10, 10, 1, ?)`,
  [randomUUID(), userId]
)

async function seedLog(status, provider = 'acctest') {
  await run(
    `INSERT INTO provider_logs (id, project_id, provider, type, status) VALUES (?, ?, ?, 'llm', ?)`,
    [randomUUID(), projectId, provider, status]
  )
}

// (a) 1 real call → usage +1.
await seedLog('ok')
{
  const snap = await getQuotaSnapshot(userId, 'acctest')
  assert(snap.usedToday === 1 && snap.daily.used === 1, `1 real call → usage +1 (got ${snap.usedToday})`)
}

// (b) cache_hit → usage +0.
await seedLog('cache_hit')
{
  const snap = await getQuotaSnapshot(userId, 'acctest')
  assert(snap.usedToday === 1, `cache_hit → usage +0 (got ${snap.usedToday})`)
}

// (c) failed/rejected statuses theo contract → +0.
await seedLog('rate_limited')
await seedLog('quota_exceeded')
await seedLog('transient')
await seedLog('error')
{
  const snap = await getQuotaSnapshot(userId, 'acctest')
  assert(snap.usedToday === 1, `rate/quota/transient/error → usage +0 (got ${snap.usedToday})`)
}

// (§6 item 5) daily/minute % độc lập — provider riêng để không lẫn fixture trên.
const user2 = randomUUID()
const project2 = randomUUID()
await run(`INSERT INTO users (id, email, password) VALUES (?, ?, ?)`, [user2, `${user2}@t.co`, 'x'])
await run(`INSERT INTO projects (id, user_id, mode, title, status) VALUES (?, ?, 'TRANSLATE_DUB', 'acct2', 'pending')`, [project2, user2])
await run(
  `INSERT INTO provider_rate_limits (id, provider, tier, requests_per_minute, requests_per_day, concurrency, user_id) VALUES (?, 'acctsplit', 'custom', 10, 1000, 1, ?)`,
  [randomUUID(), user2]
)
for (let i = 0; i < 9; i++) {
  await run(
    `INSERT INTO provider_logs (id, project_id, provider, type, status) VALUES (?, ?, ?, 'llm', 'ok')`,
    [randomUUID(), project2, 'acctsplit']
  )
}
{
  const snap = await getQuotaSnapshot(user2, 'acctsplit')
  assert(Math.abs(snap.daily.percent - 0.9) < 1e-9, `daily.percent=0.9 (got ${snap.daily.percent})`)
  assert(snap.minute.percent === 90, `minute.percent=90 (got ${snap.minute.percent})`)
  assert(snap.percentUsed === 90, 'percentUsed deprecated giữ max() cũ cho compat')
  // Warning đúng scope: daily thấp → minute warning, KHÔNG báo daily giả.
  const w = await checkQuotaWarning(user2, 'acctsplit')
  assert(w.warning?.type === 'minute_rate_limit_risk' && w.warning?.scope === 'minute', `minute spike → minute warning (got ${w.warning?.type})`)
  assert(/phút/i.test(w.warning?.message || ''), 'minute message nói đúng rate limit/phút')
  const pre = await precheckStage(user2, 'acctsplit', 10)
  assert(pre.allowed === true && pre.warning?.type === 'minute_rate_limit_risk', 'precheck minute spike → minute warning, vẫn allowed')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
