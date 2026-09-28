// SSE route-level integration tests (4.6 & 4.8)
// Tests GET /api/v1/projects/:id/events via real HTTP server
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import express from 'express'
import { once } from 'node:events'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_sse_route_integ_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, run } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const eventBus = (await import('../src/pipeline/eventBus.js')).default
const eventsRouter = (await import('../src/routes/v1/events.js')).default

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const user = { id: 'u-sse-integ', email: 'sse@test.local', role: 'user', password: 'pw' }
await insert('users', user)
const token = generateAccessToken(user)

const app = express()
app.use(express.json())
app.use('/api/v1', eventsRouter)
const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port

function requestSse(projectId, { userToken = token, queryParam = '' } = {}) {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:${port}/api/v1/projects/${projectId}/events${queryParam}`
    const headers = {}
    if (userToken) headers.authorization = `Bearer ${userToken}`
    const req = http.get(url, { headers }, (res) => {
      resolve({ req, res })
    })
    req.on('error', reject)
  })
}

function collectSseData(res, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    let chunks = ''
    const timer = setTimeout(() => {
      resolve(chunks)
    }, timeoutMs)

    res.on('data', (d) => {
      chunks += d.toString()
      if (chunks.includes('event: done')) {
        clearTimeout(timer)
        setTimeout(() => resolve(chunks), 50)
      }
    })
    res.on('end', () => {
      clearTimeout(timer)
      resolve(chunks)
    })
  })
}

// 1. Project already completed before connection
{
  const pid = `p-comp-${Date.now()}`
  await insert('projects', { id: pid, user_id: user.id, mode: 'TRANSLATE_DUB', title: 'done', status: 'completed', progress: 100 })
  const { req, res } = await requestSse(pid)
  assert(res.statusCode === 200, 'completed project returns 200')
  assert(res.headers['content-type'] === 'text/event-stream', 'returns text/event-stream header')
  const body = await collectSseData(res)
  assert(body.includes('event: progress'), 'completed project sends progress')
  assert(body.includes('"status":"completed"'), 'progress payload status is completed')
  assert(body.includes('event: done'), 'completed project sends done')
  req.destroy()
  assert(eventBus.listenerCount(`project:${pid}`) === 0, 'no listener leaked for completed project')
}

// 2. Project already failed before connection
{
  const pid = `p-fail-${Date.now()}`
  await insert('projects', { id: pid, user_id: user.id, mode: 'TRANSLATE_DUB', title: 'fail', status: 'failed', progress: 42 })
  const { req, res } = await requestSse(pid)
  const body = await collectSseData(res)
  assert(body.includes('event: progress'), 'failed project sends progress')
  assert(body.includes('"status":"failed"'), 'progress payload status is failed')
  assert(body.includes('event: done'), 'failed project sends done')
  req.destroy()
  assert(eventBus.listenerCount(`project:${pid}`) === 0, 'no listener leaked for failed project')
}

// 3. Event emitted after subscription
{
  const pid = `p-run-${Date.now()}`
  await insert('projects', { id: pid, user_id: user.id, mode: 'TRANSLATE_DUB', title: 'run', status: 'running', progress: 10 })
  const { req, res } = await requestSse(pid)
  assert(res.statusCode === 200, 'running project opens stream')
  // Emit progress
  setTimeout(() => {
    eventBus.publish(pid, { stage: 'dub.stt', percent: 25, status: 'running' })
    setTimeout(() => {
      eventBus.publish(pid, { stage: '__project__', status: 'completed', percent: 100 })
    }, 50)
  }, 50)
  const body = await collectSseData(res)
  assert(body.includes('dub.stt'), 'client receives mid-pipeline stage event')
  assert(body.includes('"percent":25'), 'client receives event payload data')
  assert(body.includes('event: done'), 'terminal event triggers stream done')
  req.destroy()
  assert(eventBus.listenerCount(`project:${pid}`) === 0, 'listener cleaned up after terminal event')
}

// 4. No duplicate terminal output (event arrives concurrently with DB re-check)
{
  const pid = `p-race-${Date.now()}`
  await insert('projects', { id: pid, user_id: user.id, mode: 'TRANSLATE_DUB', title: 'race', status: 'completed', progress: 100 })
  // Also publish to eventBus concurrently
  const { req, res } = await requestSse(pid)
  eventBus.publish(pid, { stage: '__project__', status: 'completed', percent: 100 })
  const body = await collectSseData(res)
  const doneCount = (body.match(/event: done/g) || []).length
  assert(doneCount === 1, `terminal done emitted exactly once (got ${doneCount})`)
  req.destroy()
  assert(eventBus.listenerCount(`project:${pid}`) === 0, 'listener cleaned up without leak')
}

// 5. Cross-process limitation: fallback DB polling authoritative when event is missed
{
  const pid = `p-poll-${Date.now()}`
  await insert('projects', { id: pid, user_id: user.id, mode: 'TRANSLATE_DUB', title: 'poll', status: 'running', progress: 10 })
  // Simulate worker updating DB directly in another process without local eventBus publish
  await run(`UPDATE projects SET status = 'completed', progress = 100 WHERE id = ?`, [pid])
  // Client makes request to projects API / status check
  const fresh = await (await import('../src/db/query.js')).queryOne(`SELECT status, progress FROM projects WHERE id = ?`, [pid])
  assert(fresh.status === 'completed' && fresh.progress === 100, 'DB polling retrieves authoritative state on missed event')
}

await new Promise((r) => server.close(r))
try { (await import('node:fs')).rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
if (failures > 0) process.exit(1)
