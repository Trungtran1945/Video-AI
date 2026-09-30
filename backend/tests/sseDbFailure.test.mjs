// SSE DB failure: initial authoritative DB check throws → explicit error/close.
// Contract: event 'error' { code:'DB_UNAVAILABLE', retryable:true } + cleanup
// (heartbeat cleared, listener unsubscribed) + res.end(). No infinite hang,
// no inferred terminal progress, frontend falls back to DB polling.
// Fault injection: degraded `projects` table (no `progress` column) so
// requireProjectOwner (SELECT *) passes but the handler's
// `SELECT status, progress` throws. Restored afterwards.
// Run: node backend/tests/sseDbFailure.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import { once } from 'node:events'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_sse_db_fail_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, run, queryOne } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const eventBus = (await import('../src/pipeline/eventBus.js')).default
const eventsRouter = (await import('../src/routes/v1/events.js')).default

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const user = { id: 'u-sse-dbfail', email: 'dbfail@test.local', role: 'user', password: 'pw' }
await insert('users', user)
const token = generateAccessToken(user)
const pid = `p-dbfail-${Date.now()}`
await insert('projects', { id: pid, user_id: user.id, mode: 'TRANSLATE_DUB', title: 'dbfail', status: 'running', progress: 10 })

const app = express()
app.use(express.json())
app.use('/api/v1', eventsRouter)
const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port

function requestSse(projectId) {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:${port}/api/v1/projects/${projectId}/events`
    const req = http.get(url, { headers: { authorization: `Bearer ${token}` } }, (res) => {
      resolve({ req, res })
    })
    req.on('error', reject)
  })
}

function collectUntilEnd(res, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let chunks = ''
    let ended = false
    const timer = setTimeout(() => resolve({ chunks, ended, timedOut: true }), timeoutMs)
    res.on('data', (d) => { chunks += d.toString() })
    res.on('end', () => {
      clearTimeout(timer)
      ended = true
      resolve({ chunks, ended, timedOut: false })
    })
  })
}

// 1. Source fence: DB failure path is explicit (no silent swallow → hang).
{
  const src = fs.readFileSync(new URL('../src/routes/v1/events.js', import.meta.url), 'utf8')
  assert(src.includes("event: error"), 'route emits explicit error event on DB failure')
  assert(src.includes('DB_UNAVAILABLE'), 'error payload carries DB_UNAVAILABLE code')
  assert(src.includes('sendErrorAndClose'), 'dedicated error-close path exists')
  assert(src.includes('sse_db_check_error'), 'DB check failure is observable via diagnostic')
  // The old silent-swallow pattern must be gone from the DB re-check block.
  const checkBlock = src.slice(src.indexOf('Re-check DB SAU'), src.indexOf('if (closed) return'))
  assert(!/catch\s*\(\s*_\s*\)\s*\{\s*\}/.test(checkBlock), 'DB re-check no longer silently swallows errors')
}

// 2. Live fault injection: handler query throws → error event + prompt close.
{
  // Degrade table: keep id/user_id/mode/title/status, drop `progress`.
  await run('ALTER TABLE projects RENAME TO projects_orig')
  await run('CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT, mode TEXT, title TEXT, status TEXT)')
  await run('INSERT INTO projects (id, user_id, mode, title, status) SELECT id, user_id, mode, title, status FROM projects_orig')

  const warnings = []
  const origWarn = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }

  const { req, res } = await requestSse(pid)
  const { chunks, ended, timedOut } = await collectUntilEnd(res)
  console.warn = origWarn
  try { req.destroy() } catch (_) {}

  assert(res.statusCode === 200, 'stream headers already sent (200) before DB check')
  assert(chunks.includes('event: error'), 'client receives explicit error event')
  assert(chunks.includes('DB_UNAVAILABLE'), 'error payload signals DB_UNAVAILABLE')
  assert(!chunks.includes('"status":"completed"') && !chunks.includes('"status":"failed"'), 'no terminal status is inferred from DB failure')
  assert(!/event: done/.test(chunks), 'no done event on error path (error is not terminal)')
  assert(ended === true && timedOut === false, 'stream ends promptly (no infinite hang)')
  assert(warnings.some((w) => w.includes('sse_db_check_error')), 'sse_db_check_error diagnostic emitted')
  assert(!warnings.some((w) => /Bearer|ticket|eyJ/i.test(w)), 'diagnostic leaks no token/ticket')

  await new Promise((r) => setTimeout(r, 100))
  assert(eventBus.listenerCount(`project:${pid}`) === 0, 'listener unsubscribed after DB-failure close')

  // Restore full schema.
  await run('DROP TABLE projects')
  await run('ALTER TABLE projects_orig RENAME TO projects')
}

// 3. Restored DB serves streams normally again (fault was temporary, no damage).
{
  const row = await queryOne('SELECT status, progress FROM projects WHERE id = ?', [pid])
  assert(row && row.status === 'running', 'project row intact after table restore')
  const { req, res } = await requestSse(pid)
  await new Promise((r) => setTimeout(r, 150))
  assert(eventBus.listenerCount(`project:${pid}`) === 1, 'healthy stream subscribes after restore')
  req.destroy()
  await new Promise((r) => setTimeout(r, 100))
  assert(eventBus.listenerCount(`project:${pid}`) === 0, 'healthy stream cleans up on disconnect')
}

await new Promise((r) => server.close(r))
try { fs.rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
if (failures > 0) process.exit(1)
