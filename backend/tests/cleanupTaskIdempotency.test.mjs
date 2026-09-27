// Deterministic idempotency for cleanup outbox (Task 1):
// - same operation_key + INSERT OR IGNORE yields exactly 1 pending row
// - DELETE route stamps operation/operation_key deterministically
// - sweep rerun is idempotent (done tasks never reprocessed)
// Run: node backend/tests/cleanupTaskIdempotency.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { once } from 'node:events'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-cleanup-idem-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'

const { initSchema } = await import('../src/db/schema.js')
const { insert, run, runAffected, query, queryOne } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const projectsRouter = (await import('../src/routes/v1/projects.js')).default
const { sweepProjectCleanupTasks, getCleanupStats } = await import('../src/services/projectCleanup.js')
const { connection } = await import('../src/queue/connection.js')

await initSchema()
// No live Redis in tests: detach the eager ioredis socket (redisGuard pattern).
try { connection.disconnect() } catch (_) {}

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }
const scenario = async (name, fn) => {
  try { await fn() } catch (e) { failures++; console.error(`FAIL: ${name} threw — ${e?.stack || e}`) }
}

const user = { id: 'idem-user', email: 'idem@test.local', role: 'user', password: 'x' }
await insert('users', user)

const app = express()
app.use(express.json())
app.use('/api/v1/projects', projectsRouter)
const server = app.listen(0)
await once(server, 'listening')
const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/projects`
const token = generateAccessToken(user)
const del = (id) => fetch(`${baseUrl}/${id}`, {
  method: 'DELETE',
  headers: { authorization: `Bearer ${token}`, connection: 'close' },
})

// 1) DELETE stamps deterministic operation/operation_key; duplicate claim stays at 1 row.
const pid = 'idem-p1'
const storageKey = `projects/${pid}/keep.txt`
const keepAbs = path.join(process.env.STORAGE_DIR, 'projects', pid, 'keep.txt')
const origUnlink = fs.unlinkSync
await scenario('deleteStampsDeterministicKey', async () => {
  await insert('projects', { id: pid, user_id: user.id, mode: 'SUMMARY', title: 'idem-1', status: 'queued' })
  await insert('assets', { id: 'idem-p1-asset', project_id: pid, kind: 'video', storage_key: storageKey })
  fs.mkdirSync(path.dirname(keepAbs), { recursive: true })
  fs.writeFileSync(keepAbs, 'keep me')
  // Arm fs failure so the post-commit fast path leaves the task pending.
  fs.unlinkSync = () => { const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e }
  const res = await del(pid)
  assert(res.status === 200, `DELETE succeeds despite fs fail (got ${res?.status})`)
  const task = await queryOne(`SELECT * FROM project_cleanup_tasks WHERE project_id = ?`, [pid])
  assert(task && task.operation === 'PROJECT_DELETE', 'task carries operation=PROJECT_DELETE')
  assert(task && task.operation_key === `project-delete:${pid}`, `task carries deterministic operation_key (got ${task?.operation_key})`)
  assert(task && task.status === 'pending', 'task pending after fs fail')

  // Deterministic retry: same operation_key, different id → INSERT OR IGNORE claims 0.
  const dupClaimed = await runAffected(
    `INSERT OR IGNORE INTO project_cleanup_tasks (id, project_id, keys_json, status, attempts, next_attempt_at, operation, operation_key)
     VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
    ['idem-p1-dup', pid, JSON.stringify([storageKey]), new Date().toISOString(), 'PROJECT_DELETE', `project-delete:${pid}`]
  )
  assert(dupClaimed === 0, `duplicate INSERT OR IGNORE claims nothing (got ${dupClaimed})`)
  const rows = await query(`SELECT id FROM project_cleanup_tasks WHERE operation_key = ? AND status = 'pending'`, [`project-delete:${pid}`])
  assert(rows.length === 1, `exactly 1 pending row for operation_key (got ${rows.length})`)

  // Disarm fs, make due, sweep → done + file gone.
  fs.unlinkSync = origUnlink
  await run(`UPDATE project_cleanup_tasks SET next_attempt_at = ? WHERE id = ?`, [new Date(Date.now() - 1000).toISOString(), task.id])
  const sweep1 = await sweepProjectCleanupTasks()
  assert(sweep1.processed >= 1, 'sweep processes due task')
  const done = await queryOne(`SELECT * FROM project_cleanup_tasks WHERE id = ?`, [task.id])
  assert(done.status === 'done', 'task done after retry')
  assert(!fs.existsSync(keepAbs), 'file removed after sweep')

  // Sweep rerun idempotent.
  const sweep2 = await sweepProjectCleanupTasks()
  assert(sweep2.processed === 0, `sweep rerun idempotent (got ${sweep2.processed})`)
})

// 2) Pure DB-level determinism: two INSERT OR IGNORE with the same key → 1 pending row.
await scenario('insertOrIgnoreDeterminism', async () => {
  const key = 'project-delete:idem-p2'
  const now = new Date(Date.now() - 1000).toISOString()
  const c1 = await runAffected(
    `INSERT OR IGNORE INTO project_cleanup_tasks (id, project_id, keys_json, status, attempts, next_attempt_at, operation, operation_key)
     VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
    ['idem-p2-a', 'idem-p2', JSON.stringify([]), now, 'PROJECT_DELETE', key]
  )
  const c2 = await runAffected(
    `INSERT OR IGNORE INTO project_cleanup_tasks (id, project_id, keys_json, status, attempts, next_attempt_at, operation, operation_key)
     VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
    ['idem-p2-b', 'idem-p2', JSON.stringify([]), now, 'PROJECT_DELETE', key]
  )
  assert(c1 === 1, `first claim succeeds (got ${c1})`)
  assert(c2 === 0, `second claim ignored (got ${c2})`)
  const rows = await query(`SELECT id FROM project_cleanup_tasks WHERE operation_key = ? AND status = 'pending'`, [key])
  assert(rows.length === 1 && rows[0].id === 'idem-p2-a', 'exactly 1 pending row survives')
  // Cleanup: mark done so stats stay clean.
  await run(`UPDATE project_cleanup_tasks SET status = 'done' WHERE operation_key = ?`, [key])
})

// 3) Stats expose counts without keys_json.
await scenario('cleanupStats', async () => {
  const stats = await getCleanupStats()
  assert(typeof stats.pending === 'number' && typeof stats.failed === 'number', 'stats has pending/failed counts')
  assert(typeof stats.oldestPendingAgeMs === 'number', 'stats has oldestPendingAgeMs')
  assert(!('keys_json' in stats), 'stats never exposes keys_json')
  assert(JSON.stringify(stats).includes('keys_json') === false, 'stats payload contains no storage keys')
})

fs.unlinkSync = origUnlink
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

await run(`DELETE FROM project_cleanup_tasks WHERE project_id LIKE 'idem-%' OR project_id = 'cln-%' OR id LIKE 'idem-%'`)
await run(`DELETE FROM assets WHERE project_id LIKE 'idem-%'`)
await run(`DELETE FROM projects WHERE id LIKE 'idem-%'`)
await run(`DELETE FROM users WHERE id = ?`, [user.id])
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
