// Project creation idempotency (Task 5):
// - Idempotency-Key on POST /projects: sequential + concurrent retries with the
//   same key return the SAME project (no duplicate row, no duplicate launch)
// - transcript cache-copy failure -> 202 + transcriptCopyFailed (never 500/503
//   after the project row exists; admission released -> queued)
// - post-admission DB failure -> 503 WITH projectId in the body
// - invalid key (>128 chars) -> 400
// Run: node backend/tests/projectIdempotency.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { once } from 'node:events'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-idem-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'
// Must be set before any src import — config.js / db.js read env at load.
// High admission cap so every project in this file is admitted (pending +
// runToken); the copy-failure path is then exercised through release->queued.
// MAX_SAVE_FAILURES=1 so one armed save failure WRITE_BLOCKs the DB and the
// post-admission failure surfaces as 503 (not a raw disk error).
process.env.MAX_CONCURRENT_PROJECTS_PER_USER = '10'
process.env.DB_MAX_SAVE_FAILURES = '1'

const { initSchema } = await import('../src/db/schema.js')
const { insert, query, queryOne, run } = await import('../src/db/query.js')
const { TRANSLATION_VERSION } = await import('../src/lib/cacheKey.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const projectsMod = await import('../src/routes/v1/projects.js')
const projectsRouter = projectsMod.default
const { connection } = await import('../src/queue/connection.js')

await initSchema()
// No live Redis in tests: detach the eager ioredis socket (redisGuard pattern).
try { connection.disconnect() } catch (_) {}

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// The test seam must exist BEFORE any request is made: tests replace
// copyTranscript/runPipeline with fakes (real pipeline needs FFmpeg/Redis).
const deps = projectsMod.createProjectPostDeps || {}
assert(deps && typeof deps.copyTranscript === 'function' && typeof deps.runPipeline === 'function',
  'POST seam createProjectPostDeps is exported (copyTranscript/runPipeline injectable)')
const realCopy = deps.copyTranscript
const realRun = deps.runPipeline
const pipelineCalls = []
if (typeof deps.runPipeline === 'function') {
  deps.runPipeline = (pid) => { pipelineCalls.push(pid); return Promise.resolve() }
}

const user = { id: 'idem-user', email: 'idem@test.local', role: 'user', password: 'x' }
await insert('users', user)
const token = generateAccessToken(user)

const app = express()
app.use(express.json())
app.use('/projects', projectsRouter)
const server = app.listen(0)
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}/projects`
const post = (p, body, headers = {}) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
  body: JSON.stringify(body),
})

const summaryBody = { mode: 'SUMMARY', title: 'Idem', sourceVideoKey: 'uploads/x.mp4', copyrightAcknowledged: true }
const dubBody = (title) => ({
  mode: 'TRANSLATE_DUB', title, sourceVideoKey: 'uploads/x.mp4', copyrightAcknowledged: true,
  stylePreset: 'sat-nghia', videoHash: 'vh-copy',
})

// A) Sequential retry -> 1 project
{
  const r1 = await post('/', summaryBody, { 'idempotency-key': 'idem-key-001' })
  const r2 = await post('/', summaryBody, { 'idempotency-key': 'idem-key-001' })
  assert(r1.status === 202 && r2.status === 202, `ca 2 lan retry deu 202 (got ${r1.status}/${r2.status})`)
  const b1 = await r1.json(), b2 = await r2.json()
  assert(b1.id && b1.id === b2.id, 'retry tra CUNG project id')
  assert(b2.idempotentReplay === true, 'lan retry danh dau idempotentReplay')
  const rows = await query(`SELECT id FROM projects WHERE user_id = ?`, [user.id])
  assert(rows.length === 1, `chi 1 project (thuc te ${rows.length})`)
}

// B) Concurrent same key -> 1 project
{
  const [c1, c2] = await Promise.all([
    post('/', summaryBody, { 'idempotency-key': 'idem-key-002' }),
    post('/', summaryBody, { 'idempotency-key': 'idem-key-002' }),
  ])
  const statuses = [c1.status, c2.status].sort()
  assert(statuses[0] === 202 && statuses[1] === 202, `2 request dong thoi cung key -> ca 2 202 (got ${statuses})`)
  const cb1 = await c1.json(), cb2 = await c2.json()
  assert(cb1.id && cb1.id === cb2.id, 'dong thoi cung key -> cung project id')
  const rows2 = await query(`SELECT id FROM projects WHERE user_id = ?`, [user.id])
  assert(rows2.length === 2, `tong 2 project cho 2 key (thuc te ${rows2.length})`)
}

// Source project for the transcript cache-copy path (same user + video_hash,
// completed, params compatible with dubBody()).
await insert('style_presets', {
  id: 'preset-satnghia', slug: 'sat-nghia', name: 'Sat nghia',
  description: 'seed', system_prompt: 'seed', is_system: 1,
})
await insert('projects', {
  id: 'idem-src', user_id: user.id, mode: 'TRANSLATE_DUB', title: 'src',
  status: 'completed', video_hash: 'vh-copy',
  params: JSON.stringify({
    stylePreset: 'sat-nghia', sourceLanguage: 'auto', targetLanguage: 'vi',
    enableDubbing: false, ocrMode: false, outputFormat: 'mp4',
    translationVersion: TRANSLATION_VERSION,
  }),
})
await insert('transcript_segments', {
  id: 'idem-src-seg1', project_id: 'idem-src', index_num: 0,
  start_sec: 0, end_sec: 1, text: 'hello', translation: 'xin chao',
})

// C) copyTranscript failure -> 202 + transcriptCopyFailed + project van ton tai
let copyFailId = null
{
  deps.copyTranscript = async () => { throw new Error('boom') }
  let r3
  try {
    r3 = await post('/', dubBody('Idem copy'), { 'idempotency-key': 'idem-key-003' })
  } finally {
    deps.copyTranscript = realCopy
  }
  assert(r3.status === 202, `copy failure van 202 (got ${r3.status})`)
  const b3 = await r3.json()
  copyFailId = b3.id
  assert(b3.transcriptCopyFailed === true, 'response danh dau transcriptCopyFailed')
  const proj3 = await queryOne('SELECT * FROM projects WHERE id = ?', [b3.id])
  assert(proj3 && proj3.status === 'queued' && proj3.run_token == null, 'project da ton tai, admission released -> queued')
  assert(String(proj3.recovery_reason || '').includes('cache copy failed'), 'giu recovery_reason')
  assert(pipelineCalls.includes(b3.id) === false, 'khong launch pipeline khi copy failed')
}

// D) Retry cung key sau copy failure -> replay tra project
{
  const r4 = await post('/', dubBody('Idem copy'), { 'idempotency-key': 'idem-key-003' })
  const b4 = await r4.json()
  assert(r4.status === 202 && b4.id === copyFailId, 'retry sau copy-failure tra cung project')
  assert(b4.idempotentReplay === true, 'retry sau copy-failure danh dau idempotentReplay')
}

// E) 503 khi DB ban sau admission: body co projectId, project ton tai 1 ban.
// Armed save failure tu save thu 2 (sau admission commit): copy persist fail
// (raw disk error -> copy-catch), release write gap WRITE_BLOCKED (probe fail)
// -> PersistenceBlockedError -> 503 + projectId.
{
  const beforeE = await query('SELECT id FROM projects WHERE user_id = ?', [user.id])
  const originalWriteFileSync = fs.writeFileSync
  let saveCount = 0
  fs.writeFileSync = (...args) => {
    saveCount += 1
    if (saveCount >= 2) {
      const error = new Error('EACCES: simulated save failure')
      error.code = 'EACCES'
      throw error
    }
    return originalWriteFileSync(...args)
  }
  let r5
  try {
    r5 = await post('/', dubBody('Idem E'), { 'idempotency-key': 'idem-key-005' })
  } finally {
    fs.writeFileSync = originalWriteFileSync
  }
  assert(r5.status === 503, `post-admission DB failure -> 503 (got ${r5.status})`)
  const b5 = await r5.json()
  assert(b5?.error?.code === 'DB_PERSISTENCE_BLOCKED' || b5?.code === 'DB_PERSISTENCE_BLOCKED',
    `503 giu ma loi persistence (got ${b5?.error?.code || b5?.code})`)
  // sendError places extra fields top-level (message/code/...extra/error);
  // the contract is "503 body carries projectId".
  const pid5 = b5.projectId ?? b5.error?.projectId
  assert(typeof pid5 === 'string' && pid5.length > 0, '503 body co projectId cua project da tao')
  assert(await queryOne('SELECT id FROM projects WHERE id = ?', [pid5]) !== null, 'project thuc ton tai sau 503')
  const afterE = await query('SELECT id FROM projects WHERE user_id = ?', [user.id])
  assert(afterE.length === beforeE.length + 1, `project chi ton tai 1 ban (truoc ${beforeE.length}, sau ${afterE.length})`)
}

// F) key khong hop le -> 400 (header > 128 ky tu)
{
  const r6 = await post('/', summaryBody, { 'idempotency-key': 'x'.repeat(129) })
  assert(r6.status === 400, `key > 128 ky tu -> 400 (got ${r6.status})`)
}

// cleanup
if (deps) {
  if (realCopy) deps.copyTranscript = realCopy
  if (realRun) deps.runPipeline = realRun
}
server.closeAllConnections?.()
await new Promise((resolve) => server.close(resolve))
for (let i = 0; i < 100; i++) {
  const pending = process._getActiveHandles().filter((h) => h?.constructor?.name === 'Socket')
  if (pending.length === 0) break
  await new Promise((r) => setTimeout(r, 20))
}
try { await run('DELETE FROM transcript_segments WHERE project_id LIKE ?', ['idem-%']) } catch (_) {}
try { await run('DELETE FROM project_idempotency WHERE user_id = ?', [user.id]) } catch (_) {}
await run('DELETE FROM projects WHERE user_id = ?', [user.id])
await run('DELETE FROM style_presets WHERE id = ?', ['preset-satnghia'])
await run('DELETE FROM users WHERE id = ?', [user.id])
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
process.exit(failures === 0 ? 0 : 1)
