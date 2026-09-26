// Post-commit boundaries (Issue B):
// - one user action's DB mutations commit as ONE transaction (no partial wipe)
// - a post-commit side effect (abort/fs/notify) failing never flips an
//   already-committed change into an API failure
// Run: node backend/tests/postCommitBoundaries.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { once } from 'node:events'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-postcommit-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'

const { initSchema } = await import('../src/db/schema.js')
const { insert, run, queryOne } = await import('../src/db/query.js')
const { cancelProjectUseCase } = await import('../src/usecases/cancelProjectUseCase.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const projectsRouter = (await import('../src/routes/v1/projects.js')).default
const { connection } = await import('../src/queue/connection.js')

await initSchema()
// No live Redis in tests: detach the eager ioredis socket (redisGuard pattern).
try { connection.disconnect() } catch (_) {}

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }
const scenario = async (name, fn) => {
  try { await fn() } catch (e) { failures++; console.error(`FAIL: ${name} threw — ${e?.stack || e}`) }
}

const user = { id: 'pcb-user', email: 'pcb@test.local', role: 'user', password: 'x' }
await insert('users', user)

const originalWriteFileSync = fs.writeFileSync
let saveCalls = 0
let armFailures = false
fs.writeFileSync = (...args) => {
  if (armFailures) {
    const error = new Error('EACCES: simulated save failure')
    error.code = 'EACCES'
    throw error
  }
  saveCalls += 1
  return originalWriteFileSync(...args)
}
const disarm = () => { armFailures = false }

// ── 1. cancel: DB mutations commit atomically (save failure → nothing changes) ──
await scenario('cancelAtomic', async () => {
  await insert('projects', { id: 'pcb-c1', user_id: user.id, mode: 'SUMMARY', title: 'c1', status: 'queued' })
  await insert('generation_jobs', { id: 'pcb-c1-job', project_id: 'pcb-c1', type: 'summary.render', status: 'pending' })
  const abortCalls = []

  armFailures = true
  let error = null
  try {
    await cancelProjectUseCase('pcb-c1', { abort: () => abortCalls.push('x') })
  } catch (e) { error = e } finally { disarm() }
  assert(error?.code === 'EACCES', `cancel save failure rejects with the disk error (got ${error?.code})`)

  const project = await queryOne('SELECT status FROM projects WHERE id = ?', ['pcb-c1'])
  const job = await queryOne('SELECT status FROM generation_jobs WHERE id = ?', ['pcb-c1-job'])
  assert(project?.status === 'queued', `failed cancel leaves project status unchanged (got ${project?.status})`)
  assert(job?.status === 'pending', `failed cancel leaves job status unchanged (got ${job?.status})`)
  assert(abortCalls.length === 0, 'abort side effect never runs when the DB commit failed')

  // success path: commit first, then side effects
  const result = await cancelProjectUseCase('pcb-c1', { abort: () => abortCalls.push('x') })
  assert(result?.status === 'cancelled', `successful cancel returns the cancelled project (got ${result?.status})`)
  assert(abortCalls.length === 1, `abort runs exactly once after commit (got ${abortCalls.length})`)
  const jobAfter = await queryOne('SELECT status FROM generation_jobs WHERE id = ?', ['pcb-c1-job'])
  assert(jobAfter?.status === 'cancelled', 'jobs are cancelled in the same commit')
})

// ── 2. cancel: a throwing post-commit side effect still returns success ──
await scenario('cancelSideEffectFailure', async () => {
  await insert('projects', { id: 'pcb-c2', user_id: user.id, mode: 'SUMMARY', title: 'c2', status: 'queued' })
  await insert('generation_jobs', { id: 'pcb-c2-job', project_id: 'pcb-c2', type: 'summary.render', status: 'running' })

  let result = null
  let error = null
  try {
    result = await cancelProjectUseCase('pcb-c2', {
      abort: () => { throw new Error('side effect boom') },
    })
  } catch (e) { error = e }
  assert(error === null, `post-commit side effect failure does not fail the cancel (got ${error?.message})`)
  assert(result?.status === 'cancelled', 'cancel still returns the committed result')
  const project = await queryOne('SELECT status FROM projects WHERE id = ?', ['pcb-c2'])
  assert(project?.status === 'cancelled', 'cancellation is committed despite the side effect failure')
})

// ── 3. project DELETE: ONE transaction = ONE save (no partial wipe possible) ──
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

await scenario('deleteSingleCommit', async () => {
  await insert('projects', { id: 'pcb-d1', user_id: user.id, mode: 'SUMMARY', title: 'd1', status: 'queued' })
  await insert('generation_jobs', { id: 'pcb-d1-job', project_id: 'pcb-d1', type: 'summary.render', status: 'pending' })
  await insert('provider_logs', { id: 'pcb-d1-log', project_id: 'pcb-d1', provider: 'test' })
  await insert('transcript_segments', { id: 'pcb-d1-seg', project_id: 'pcb-d1', index_num: 0, start_sec: 0, end_sec: 1, text: 'hi' })

  saveCalls = 0
  const res = await del('pcb-d1')
  assert(res.status === 200, `DELETE succeeds (got ${res.status})`)
  assert(saveCalls === 1,
    `the whole DB wipe commits with exactly ONE save() — no partial deletion window (got ${saveCalls})`)

  assert(await queryOne('SELECT id FROM projects WHERE id = ?', ['pcb-d1']) === null, 'project row deleted')
  assert(await queryOne('SELECT id FROM generation_jobs WHERE id = ?', ['pcb-d1-job']) === null, 'jobs deleted')
  assert(await queryOne('SELECT id FROM transcript_segments WHERE id = ?', ['pcb-d1-seg']) === null, 'transcript deleted')
  assert(await queryOne('SELECT id FROM provider_logs WHERE id = ?', ['pcb-d1-log']) !== null, 'provider_logs kept (analytics)')
})

await scenario('deleteRollbackAndRetry', async () => {
  await insert('projects', { id: 'pcb-d2', user_id: user.id, mode: 'SUMMARY', title: 'd2', status: 'queued' })
  await insert('provider_logs', { id: 'pcb-d2-log', project_id: 'pcb-d2', provider: 'test' })
  await insert('transcript_segments', { id: 'pcb-d2-seg', project_id: 'pcb-d2', index_num: 0, start_sec: 0, end_sec: 1, text: 'hi' })

  armFailures = true
  let failedRes = null
  try { failedRes = await del('pcb-d2') } finally { disarm() }
  assert(failedRes && failedRes.status >= 500, `failed persistence surfaces as an API error (got ${failedRes?.status})`)
  assert(await queryOne('SELECT id FROM projects WHERE id = ?', ['pcb-d2']) !== null,
    'failed DELETE leaves the project row (no partial wipe)')
  assert((await queryOne('SELECT project_id FROM provider_logs WHERE id = ?', ['pcb-d2-log']))?.project_id === 'pcb-d2',
    'failed DELETE keeps provider_logs attached')
  assert(await queryOne('SELECT id FROM transcript_segments WHERE id = ?', ['pcb-d2-seg']) !== null,
    'failed DELETE keeps the transcript')

  const retry = await del('pcb-d2')
  assert(retry.status === 200, `retry after failure succeeds (got ${retry.status})`)
  assert(await queryOne('SELECT id FROM projects WHERE id = ?', ['pcb-d2']) === null, 'retry deletes the project')
  assert(await queryOne('SELECT id FROM transcript_segments WHERE id = ?', ['pcb-d2-seg']) === null,
    'retry deletes the transcript exactly once')
  assert(await queryOne('SELECT id FROM provider_logs WHERE id = ?', ['pcb-d2-log']) !== null,
    'retry still keeps provider_logs')
})

fs.writeFileSync = originalWriteFileSync
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

// ── 4. Source fences ──
{
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
  const cancelSrc = read('src/usecases/cancelProjectUseCase.js')
  assert(cancelSrc.includes('withTransaction('), 'cancel commits its DB mutations in one transaction')
  assert(cancelSrc.includes('try {') && /try\s*\{[^}]*abort\(projectId\)/.test(cancelSrc),
    'cancel guards the abort side effect so it cannot fail a committed cancel')
  assert(cancelSrc.includes('deps = {}'), 'cancel exposes injectable side effects for testing')

  const projectsSrc = read('src/routes/v1/projects.js')
  const delBody = projectsSrc.slice(projectsSrc.indexOf("router.delete('/:id'"))
  assert(delBody.includes('withTransaction('), 'project DELETE wipes rows in one transaction')
  assert(!delBody.includes('await deleteProjectTranscript'),
    'project DELETE no longer nests a second transaction (deadlock/partial-commit risk)')
  const tries = (delBody.match(/try\s*\{/g) || []).length
  assert(tries >= 2 && delBody.includes('deleteProjectFiles('),
    `project DELETE wraps post-commit file cleanup in its own try/catch (got ${tries} try blocks)`)
  const afterFiles = delBody.slice(delBody.indexOf('deleteProjectFiles('))
  assert(/catch/.test(afterFiles), 'file cleanup failure is caught and cannot fail the request')
}

await run("DELETE FROM provider_logs WHERE project_id LIKE 'pcb-%'")
await run("DELETE FROM generation_jobs WHERE project_id LIKE 'pcb-%'")
await run("DELETE FROM transcript_segments WHERE project_id LIKE 'pcb-%'")
await run("DELETE FROM projects WHERE id LIKE 'pcb-%'")
await run("DELETE FROM users WHERE id = ?", [user.id])
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log('ALL PASS')
process.exit(failures === 0 ? 0 : 1)
