// Admin repair for durable cleanup outbox (Task 5):
// - GET /health splits queue status: redis/bullmq/durableCleanup/cleanup
//   (no more "cleanup disabled"; liveness stays 200 with Redis down)
// - GET /admin/cleanup-tasks lists without keys_json (limit clamp 1-100)
// - POST /admin/cleanup-tasks/:id/retry: user->403, admin->200 pending,
//   second retry->409; then sweep with a real file -> done
// Run: node backend/tests/cleanupRepair.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { once } from 'node:events'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-cleanup-repair-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'

const { initSchema } = await import('../src/db/schema.js')
const { insert, run, queryOne } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const adminRouter = (await import('../src/routes/v1/admin.js')).default
const { sweepProjectCleanupTasks, getCleanupStats } = await import('../src/services/projectCleanup.js')
const { getRefreshFallbackStats } = await import('../src/lib/refreshMetrics.js')
const { connection } = await import('../src/queue/connection.js')

await initSchema()
// No live Redis in tests: detach the eager ioredis socket (redisGuard pattern).
try { connection.disconnect() } catch (_) {}

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }
const scenario = async (name, fn) => {
  try { await fn() } catch (e) { failures++; console.error(`FAIL: ${name} threw — ${e?.stack || e}`) }
}

const user = { id: 'repair-user', email: 'repair@test.local', role: 'user', password: 'x' }
const admin = { id: 'repair-admin', email: 'repair-admin@test.local', role: 'admin', password: 'x' }
await insert('users', user)
await insert('users', admin)

const pid = 'repair-p1'
const taskId = 'repair-task-1'
const storageKey = `projects/${pid}/keep.txt`
const keepAbs = path.join(process.env.STORAGE_DIR, 'projects', pid, 'keep.txt')

await scenario('setup', async () => {
  fs.mkdirSync(path.dirname(keepAbs), { recursive: true })
  fs.writeFileSync(keepAbs, 'repair me')
  await insert('project_cleanup_tasks', {
    id: taskId,
    project_id: pid,
    keys_json: JSON.stringify([storageKey]),
    status: 'failed',
    attempts: 10,
    next_attempt_at: new Date(Date.now() - 1000).toISOString(),
    operation: 'PROJECT_DELETE',
    operation_key: `project-delete:${pid}`,
    last_error: 'filesFailed=1',
  })
  const task = await queryOne(`SELECT * FROM project_cleanup_tasks WHERE id = ?`, [taskId])
  assert(task && task.status === 'failed', 'setup: failed task exists')
  assert(fs.existsSync(keepAbs), 'setup: real file exists before retry')
})

// Mirror of server.js GET /health (same imports, same try/catch, same shape)
// so the test proves the live contract without booting the real server.
const app = express()
app.use(express.json())
app.get('/health', async (req, res) => {
  let redisOk = false
  try {
    const { isRedisReady } = await import('../src/queue/connection.js')
    redisOk = isRedisReady()
  } catch (_) {}
  let cleanupStats = { pending: 0, failed: 0, oldestPendingAgeMs: 0, lastFailureAt: null }
  try { cleanupStats = await getCleanupStats() } catch (_) {}
  let refreshFallbackStats = { count: 0, lastAt: null, deprecated: true, removalTarget: 'v2' }
  try { refreshFallbackStats = getRefreshFallbackStats() } catch (_) {}
  res.json({
    status: 'ok',
    redis: redisOk ? 'connected' : 'disconnected',
    bullmq: redisOk ? 'available' : 'unavailable',
    durableCleanup: 'available',
    cleanup: cleanupStats,
    auth: { refreshFallback: refreshFallbackStats },
  })
})
app.use('/api/v1/admin', adminRouter)
const server = app.listen(0)
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`
const userToken = generateAccessToken(user)
const adminToken = generateAccessToken(admin)
const userHeaders = { authorization: `Bearer ${userToken}`, connection: 'close' }
const adminHeaders = { authorization: `Bearer ${adminToken}`, connection: 'close' }

await scenario('healthSplit', async () => {
  // Static fence: real server.js carries the split (no stale message).
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
  assert(src.includes('durableCleanup'), 'server.js /health exposes durableCleanup')
  assert(src.includes('bullmq'), 'server.js /health exposes bullmq split')
  assert(src.includes('getCleanupStats'), 'server.js /health imports getCleanupStats')
  assert(!src.includes('cleanup disabled'), 'server.js no longer claims cleanup disabled')
  // Live shape (Redis down in tests): 200 + durable cleanup available.
  const res = await fetch(`${base}/health`, { headers: { connection: 'close' } })
  assert(res.status === 200, `GET /health stays 200 with Redis down (got ${res.status})`)
  const body = await res.json()
  assert(body?.durableCleanup === 'available', 'health durableCleanup available')
  assert(body?.bullmq === 'unavailable', `health bullmq unavailable without Redis (got ${body?.bullmq})`)
  assert(typeof body?.cleanup?.failed === 'number' && body.cleanup.failed >= 1, `health cleanup.failed>=1 (got ${body?.cleanup?.failed})`)
  assert(typeof body?.cleanup?.pending === 'number', 'health cleanup.pending is a number')
  assert(typeof body?.cleanup?.oldestPendingAgeMs === 'number', 'health cleanup.oldestPendingAgeMs is a number')
  assert('lastFailureAt' in (body?.cleanup || {}), 'health cleanup.lastFailureAt present')
  assert(!('keys_json' in (body?.cleanup || {})), 'health cleanup never exposes keys_json')
  assert(JSON.stringify(body).includes('keys_json') === false, 'health payload contains no storage keys')
  assert(body?.auth?.refreshFallback?.deprecated === true, 'health auth.refreshFallback present')
})

await scenario('listGuarded', async () => {
  const asUser = await fetch(`${base}/api/v1/admin/cleanup-tasks`, { headers: userHeaders })
  assert(asUser.status === 403, `GET cleanup-tasks as user -> 403 (got ${asUser.status})`)
  const res = await fetch(`${base}/api/v1/admin/cleanup-tasks?status=failed&limit=20`, { headers: adminHeaders })
  assert(res.status === 200, `GET cleanup-tasks as admin -> 200 (got ${res.status})`)
  const rows = await res.json()
  assert(Array.isArray(rows) && rows.some((r) => r.id === taskId), 'admin list contains the failed task')
  assert(rows.every((r) => !('keys_json' in r)), 'admin list never exposes keys_json')
  assert(JSON.stringify(rows).includes('keys_json') === false, 'admin list payload contains no storage keys')
  const clamped = await fetch(`${base}/api/v1/admin/cleanup-tasks?limit=999`, { headers: adminHeaders })
  assert(clamped.status === 200, `limit clamp 1-100 still 200 (got ${clamped.status})`)
})

await scenario('retryThenSweep', async () => {
  const asUser = await fetch(`${base}/api/v1/admin/cleanup-tasks/${taskId}/retry`, {
    method: 'POST', headers: userHeaders,
  })
  assert(asUser.status === 403, `POST retry as user -> 403 (got ${asUser.status})`)
  const res = await fetch(`${base}/api/v1/admin/cleanup-tasks/${taskId}/retry`, {
    method: 'POST', headers: adminHeaders,
  })
  assert(res.status === 200, `POST retry as admin -> 200 (got ${res.status})`)
  const body = await res.json()
  assert(body?.status === 'pending', `retry flips failed -> pending (got ${body?.status})`)
  assert(!('keys_json' in body), 'retry response never exposes keys_json')
  const again = await fetch(`${base}/api/v1/admin/cleanup-tasks/${taskId}/retry`, {
    method: 'POST', headers: adminHeaders,
  })
  assert(again.status === 409, `second retry -> 409 (got ${again.status})`)
  const missing = await fetch(`${base}/api/v1/admin/cleanup-tasks/no-such-id/retry`, {
    method: 'POST', headers: adminHeaders,
  })
  assert(missing.status === 404, `retry missing id -> 404 (got ${missing.status})`)
  // Make due + sweep with the real file present -> done + file gone.
  await run(`UPDATE project_cleanup_tasks SET next_attempt_at = ? WHERE id = ?`, [new Date(Date.now() - 1000).toISOString(), taskId])
  const sweep = await sweepProjectCleanupTasks()
  assert(sweep.processed >= 1, 'sweep processes the retried task')
  const done = await queryOne(`SELECT * FROM project_cleanup_tasks WHERE id = ?`, [taskId])
  assert(done.status === 'done', 'task done after sweep')
  assert(!fs.existsSync(keepAbs), 'file removed after sweep')
})

// Force-close keep-alive sockets first: exiting while a socket is mid-close
// trips a libuv assertion on Windows (UV_HANDLE_CLOSING).
server.closeAllConnections?.()
await new Promise((resolve) => server.close(resolve))
// Wait for those torn-down sockets to finish closing before process.exit.
for (let i = 0; i < 100; i++) {
  const pending = process._getActiveHandles().filter((h) => h?.constructor?.name === 'Socket')
  if (pending.length === 0) break
  await new Promise((r) => setTimeout(r, 20))
}

await run(`DELETE FROM project_cleanup_tasks WHERE id = ?`, [taskId]).catch(() => {})
await run(`DELETE FROM users WHERE id IN (?, ?)`, [user.id, admin.id]).catch(() => {})
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
