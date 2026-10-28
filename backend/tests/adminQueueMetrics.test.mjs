// R3 Chu kỳ 2 — GET /admin/queue-metrics: shape 200 + counts; 403 non-admin;
// Redis-down degraded (không 500); không lộ keys_json.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { once } from 'node:events'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-adminq-'))
process.env.DB_PATH = path.join(tmpDir, 'test.db')
process.env.STORAGE_DIR = path.join(tmpDir, 'storage')
process.env.NODE_ENV = 'test'

const { initSchema } = await import('../src/db/schema.js')
const { insert } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const adminRouter = (await import('../src/routes/v1/admin.js')).default
await initSchema()

let failures = 0
function assert(condition, message) {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

const admin = { id: 'u-admin-q', email: 'admin-q@test.local', role: 'admin', name: 'Admin', password: 'pw' }
const user = { id: 'u-user-q', email: 'user-q@test.local', role: 'user', name: 'User', password: 'pw' }
await insert('users', admin)
await insert('users', user)
const adminToken = generateAccessToken(admin)
const userToken = generateAccessToken(user)

// Seed project statuses cho dbFallback counts.
const now = Date.now()
await insert('projects', { id: 'p-q-1', user_id: user.id, mode: 'SUMMARY', title: 'q1', status: 'queued', transcript_version: 0 })
await insert('projects', { id: 'p-q-2', user_id: user.id, mode: 'SUMMARY', title: 'q2', status: 'queued', transcript_version: 0 })
await insert('projects', { id: 'p-r-1', user_id: user.id, mode: 'SUMMARY', title: 'r1', status: 'running', transcript_version: 0 })
await insert('projects', { id: 'p-c-1', user_id: user.id, mode: 'SUMMARY', title: 'c1', status: 'completed', transcript_version: 0 })
void now

const app = express()
app.use(express.json())
app.use('/admin', adminRouter)
const server = app.listen(0, '127.0.0.1')
await once(server, 'listening')
const port = server.address().port
const url = `http://127.0.0.1:${port}/admin/queue-metrics`

// 1. Admin → 200 đúng shape.
const res = await fetch(url, { headers: { Authorization: `Bearer ${adminToken}` } })
assert(res.status === 200, `admin GET queue-metrics → 200 (got ${res.status})`)
const body = await res.json()
assert(typeof body.generatedAt === 'string', 'có generatedAt ISO')
assert(body.redis && (body.redis.status === 'connected' || body.redis.status === 'disconnected'), `có redis.status (got ${body.redis?.status})`)
assert(typeof body.bullmq?.available === 'boolean', 'có bullmq.available boolean')
for (const name of ['projects', 'drain-queued', 'notifications', 'cleanup']) {
  const q = body.queues?.[name]
  const hasCounts = q && typeof q.waiting === 'number' && typeof q.active === 'number'
    && typeof q.delayed === 'number' && typeof q.paused === 'boolean'
  assert(Boolean(hasCounts || q?.error === 'REDIS_UNAVAILABLE'), `queue ${name} có counts hoặc REDIS_UNAVAILABLE (got ${JSON.stringify(q)})`)
}
assert(body.dbFallback?.byProjectStatus?.queued === 2, `dbFallback queued=2 (got ${body.dbFallback?.byProjectStatus?.queued})`)
assert(body.dbFallback?.byProjectStatus?.running === 1, `dbFallback running=1 (got ${body.dbFallback?.byProjectStatus?.running})`)
assert(body.dbFallback?.byProjectStatus?.completed === 1, `dbFallback completed=1 (got ${body.dbFallback?.byProjectStatus?.completed})`)
assert(typeof body.dbFallback?.maxConcurrentPerUser === 'number' && body.dbFallback.maxConcurrentPerUser > 0, `có maxConcurrentPerUser từ config (got ${body.dbFallback?.maxConcurrentPerUser})`)
assert(typeof body.dbFallback?.oldestQueuedAgeMs === 'number', 'có oldestQueuedAgeMs number')
assert(typeof body.cleanupOutbox?.pending === 'number' && typeof body.cleanupOutbox?.failed === 'number', 'có cleanupOutbox pending/failed')

// 2. Redis down (môi trường này) → degraded, không 500, queue lỗi có error field.
const anyQueueError = Object.values(body.queues || {}).some((q) => q?.error === 'REDIS_UNAVAILABLE')
if (body.redis.status === 'disconnected') {
  assert(anyQueueError || body.bullmq.available === false, 'Redis down → queues degraded (error field hoặc bullmq unavailable)')
} else {
  console.log('PASS: redis connected — bỏ qua assert degraded (môi trường có redis)')
}

// 3. Non-admin → 403, không lộ số liệu.
const forbidden = await fetch(url, { headers: { Authorization: `Bearer ${userToken}` } })
assert(forbidden.status === 403, `user thường → 403 (got ${forbidden.status})`)

// 4. Không lộ key material.
assert(!JSON.stringify(body).includes('keys_json'), 'response không chứa keys_json')

// Teardown: đóng BullMQ handles (import route kéo theo 4 Queue connections;
// pattern như cancelStageGuard/quarantine) + HTTP server, tránh crash on exit
// (Windows uv_async double-close khi process.exit đua với handle đang đóng).
await new Promise((resolve) => server.close(resolve)).catch(() => {})
try {
  const { connection } = await import('../src/queue/connection.js')
  try { connection.disconnect() } catch (_) {}
  const { projectQueue } = await import('../src/queue/projectQueue.js')
  const { drainQueue } = await import('../src/queue/drainQueue.js')
  const { notifyQueue } = await import('../src/queue/notifyQueue.js')
  const { cleanupQueue } = await import('../src/queue/cleanupQueue.js')
  await Promise.all([projectQueue.close(), drainQueue.close(), notifyQueue.close(), cleanupQueue.close()].map((p) => p.catch(() => {})))
} catch (_) {}
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
// Đợi handles Redis đóng hẳn trước khi exit (pattern quarantine.test.mjs:94).
await new Promise((r) => setTimeout(r, 500))
if (failures > 0) process.exit(1)
console.log('ALL PASS')
process.exit(0)
