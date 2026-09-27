// Durable filesystem cleanup after DELETE (Task 6, outbox pattern):
// - task row commits atomically with the DB wipe; fs failure never loses it
// - failure -> pending with backoff -> sweep retries -> eventual cleanup
// - path-unsafe keys can never escape STORAGE_DIR (resolveStorageKey guard)
// Run: node backend/tests/cleanupDurability.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { once } from 'node:events'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-cleanup-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'

const { initSchema } = await import('../src/db/schema.js')
const { insert, run, queryOne } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const projectsRouter = (await import('../src/routes/v1/projects.js')).default
const { sweepProjectCleanupTasks } = await import('../src/services/projectCleanup.js')
const { connection } = await import('../src/queue/connection.js')

await initSchema()
// No live Redis in tests: detach the eager ioredis socket (redisGuard pattern).
try { connection.disconnect() } catch (_) {}

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }
const scenario = async (name, fn) => {
  try { await fn() } catch (e) { failures++; console.error(`FAIL: ${name} threw — ${e?.stack || e}`) }
}

const user = { id: 'cln-user', email: 'cln@test.local', role: 'user', password: 'x' }
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

const pid = 'cln-p1'
const storageKey = `projects/${pid}/keep.txt`
const keepAbs = path.join(process.env.STORAGE_DIR, 'projects', pid, 'keep.txt')
await scenario('setup', async () => {
  await insert('projects', { id: pid, user_id: user.id, mode: 'SUMMARY', title: 'cleanup-1', status: 'queued' })
  await insert('assets', { id: 'cln-p1-asset', project_id: pid, kind: 'video', storage_key: storageKey })
  await insert('transcript_segments', { id: 'cln-p1-seg', project_id: pid, index_num: 0, start_sec: 0, end_sec: 1, text: 'hi' })
  fs.mkdirSync(path.dirname(keepAbs), { recursive: true })
  fs.writeFileSync(keepAbs, 'keep me')
  assert(fs.existsSync(keepAbs), 'setup: real file exists before DELETE')
})

// 1) DELETE với fs.unlinkSync bị arm lỗi → response 200 'Deleted'
const origUnlink = fs.unlinkSync
await scenario('deleteSucceedsDespiteFsFailure', async () => {
  fs.unlinkSync = () => { const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e }
  const res = await del(pid)
  assert(res.status === 200, `DB deletion thành công kể cả fs fail (got ${res?.status})`)
  const task = await queryOne(`SELECT * FROM project_cleanup_tasks WHERE project_id = ?`, [pid])
  assert(task && task.status === 'pending', 'task cleanup tồn tại, pending sau fs fail')
  assert(task && task.attempts >= 1, 'attempt đã được ghi nhận')
  const keys = JSON.parse(task.keys_json)
  assert(keys.every((k) => typeof k === 'string' && !k.startsWith('/') && !/^[A-Za-z]:/.test(k)), 'keys là storage key tương đối, không có absolute path')
  const proj = await queryOne('SELECT id FROM projects WHERE id = ?', [pid])
  assert(!proj, 'project row đã xóa')

  // 2) Retry có backoff: next_attempt_at nằm trong tương lai
  assert(new Date(task.next_attempt_at).getTime() > Date.now(), 'backoff: next_attempt_at tương lai')

  // 3) Sweep với task chưa đến hạn → không xử lý; set next_attempt_at = quá khứ
  //    + disarm fs → sweep → task done + file biến mất
  fs.unlinkSync = origUnlink
  const sweepEarly = await sweepProjectCleanupTasks()
  assert(sweepEarly.processed === 0, `task chưa đến hạn không bị sweep sớm (got ${sweepEarly.processed})`)
  await run(`UPDATE project_cleanup_tasks SET next_attempt_at = ? WHERE id = ?`, [new Date(Date.now() - 1000).toISOString(), task.id])
  const sweep1 = await sweepProjectCleanupTasks()
  assert(sweep1.processed >= 1, 'sweep xử lý task đến hạn')
  const done = await queryOne(`SELECT * FROM project_cleanup_tasks WHERE id = ?`, [task.id])
  assert(done.status === 'done', 'task done sau retry')
  assert(!fs.existsSync(keepAbs), 'file thực sự biến mất')

  // 4) Sweep lần 2 → idempotent (processed không tính task done; không throw)
  const sweep2 = await sweepProjectCleanupTasks()
  assert(sweep2.processed === 0, `sweep lần 2 idempotent, không xử lý task done (got ${sweep2.processed})`)
})

// 5) Path safety: task với key '../../etc/passwd' → resolveStorageKey trả null (đã bị guard):
//    tạo file ngoài STORAGE_DIR, giao key tương ứng, sweep → file vẫn còn nguyên.
await scenario('pathSafety', async () => {
  const outsidePath = path.join(tmpRoot, 'outside.txt')
  fs.writeFileSync(outsidePath, 'do not touch')
  await insert('project_cleanup_tasks', {
    id: 'cln-evil', project_id: 'cln-evil-proj', keys_json: JSON.stringify(['../outside.txt']),
    status: 'pending', attempts: 0, next_attempt_at: new Date(Date.now() - 1000).toISOString(),
  })
  const sweep3 = await sweepProjectCleanupTasks()
  assert(sweep3.processed >= 1, 'sweep xử lý task path-unsafe mà không throw')
  assert(fs.existsSync(outsidePath), 'file ngoài STORAGE_DIR vẫn còn nguyên (path guard)')
  const evil = await queryOne(`SELECT * FROM project_cleanup_tasks WHERE id = ?`, ['cln-evil'])
  assert(evil && evil.status === 'done', 'task path-unsafe done (không có gì hợp lệ để xóa)')
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

await run(`DELETE FROM project_cleanup_tasks WHERE project_id LIKE 'cln-%' OR id = 'cln-evil'`)
await run(`DELETE FROM transcript_segments WHERE project_id LIKE 'cln-%'`)
await run(`DELETE FROM assets WHERE project_id LIKE 'cln-%'`)
await run(`DELETE FROM projects WHERE id LIKE 'cln-%'`)
await run(`DELETE FROM users WHERE id = ?`, [user.id])
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
