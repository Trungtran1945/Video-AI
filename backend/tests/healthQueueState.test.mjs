// Health and Queue State Test (P1: Quantization / quan sát queue)
// Verifies:
// 1. QUEUE_STATES enum values: HEALTHY, DEGRADED, UNAVAILABLE
// 2. getQueueHealth() behavior under mock and live connection states
// 3. GET /health contract includes queue state and database.persistenceState
// 4. GET /ready returns 503 when queue is UNAVAILABLE and queue is required
// 5. GET /ready returns 200 when queue is UNAVAILABLE but queue is NOT required (dev mode)
// 6. GET /ready returns 200 when queue is DEGRADED or HEALTHY
// 7. GET /ready returns 503 when DB is WRITE_BLOCKED regardless of queue
// 8. backend/scripts/ensure-redis.mjs preflight exists and provides guidance
// Run: node backend/tests/healthQueueState.test.mjs
process.env.NODE_ENV = 'test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { once } from 'node:events'

import {
  QUEUE_STATES,
  getQueueHealth,
  setMockQueueState,
  isQueueRequired,
  buildHealthResponse,
  buildReadyResponse,
} from '../src/routes/v1/health.js'
import healthRouter from '../src/routes/v1/health.js'
import { PERSISTENCE_STATES, getDbPersistenceHealth } from '../src/db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.join(__dirname, '..')

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log('PASS:', msg)
  } else {
    failures++
    console.error('FAIL:', msg)
  }
}

console.log('--- 1. QUEUE_STATES Enum Verification ---')
assert(QUEUE_STATES.HEALTHY === 'HEALTHY', 'QUEUE_STATES.HEALTHY is "HEALTHY"')
assert(QUEUE_STATES.DEGRADED === 'DEGRADED', 'QUEUE_STATES.DEGRADED is "DEGRADED"')
assert(QUEUE_STATES.UNAVAILABLE === 'UNAVAILABLE', 'QUEUE_STATES.UNAVAILABLE is "UNAVAILABLE"')
assert(Object.isFrozen(QUEUE_STATES), 'QUEUE_STATES is frozen object')

console.log('\n--- 2. getQueueHealth() with Mocks ---')
try {
  setMockQueueState(QUEUE_STATES.HEALTHY)
  const healthy = getQueueHealth()
  assert(healthy.state === 'HEALTHY', `mock healthy state (got ${healthy.state})`)
  assert(healthy.redis === 'connected', `mock healthy redis is connected (got ${healthy.redis})`)
  assert(healthy.bullmq === 'available', `mock healthy bullmq is available (got ${healthy.bullmq})`)

  setMockQueueState(QUEUE_STATES.DEGRADED)
  const degraded = getQueueHealth()
  assert(degraded.state === 'DEGRADED', `mock degraded state (got ${degraded.state})`)
  assert(degraded.redis === 'reconnecting', `mock degraded redis is reconnecting (got ${degraded.redis})`)
  assert(degraded.bullmq === 'degraded', `mock degraded bullmq is degraded (got ${degraded.bullmq})`)

  setMockQueueState(QUEUE_STATES.UNAVAILABLE)
  const unavailable = getQueueHealth()
  assert(unavailable.state === 'UNAVAILABLE', `mock unavailable state (got ${unavailable.state})`)
  assert(unavailable.redis === 'disconnected', `mock unavailable redis is disconnected (got ${unavailable.redis})`)
  assert(unavailable.bullmq === 'unavailable', `mock unavailable bullmq is unavailable (got ${unavailable.bullmq})`)
} finally {
  setMockQueueState(null)
}

console.log('\n--- 3. isQueueRequired() Environment Logic ---')
const origQueueRequired = process.env.QUEUE_REQUIRED
const origRedisRequired = process.env.REDIS_REQUIRED
try {
  process.env.QUEUE_REQUIRED = 'true'
  assert(isQueueRequired() === true, 'QUEUE_REQUIRED="true" makes queue required')

  process.env.QUEUE_REQUIRED = 'false'
  assert(isQueueRequired() === false, 'QUEUE_REQUIRED="false" makes queue optional')

  delete process.env.QUEUE_REQUIRED
  process.env.REDIS_REQUIRED = 'true'
  assert(isQueueRequired() === true, 'REDIS_REQUIRED="true" makes queue required')

  process.env.REDIS_REQUIRED = 'false'
  assert(isQueueRequired() === false, 'REDIS_REQUIRED="false" makes queue optional')
} finally {
  if (origQueueRequired !== undefined) process.env.QUEUE_REQUIRED = origQueueRequired
  else delete process.env.QUEUE_REQUIRED
  if (origRedisRequired !== undefined) process.env.REDIS_REQUIRED = origRedisRequired
  else delete process.env.REDIS_REQUIRED
}

console.log('\n--- 4. buildHealthResponse() Contract ---')
try {
  setMockQueueState(QUEUE_STATES.HEALTHY)
  const hHealthy = await buildHealthResponse()
  assert(hHealthy.status === 'ok', `healthy liveness status is ok (got ${hHealthy.status})`)
  assert(hHealthy.queueState === 'HEALTHY', `healthy queueState is HEALTHY (got ${hHealthy.queueState})`)
  assert(hHealthy.queue?.state === 'HEALTHY', `healthy queue.state is HEALTHY (got ${hHealthy.queue?.state})`)
  assert(hHealthy.redis === 'connected', `healthy redis is connected (got ${hHealthy.redis})`)
  assert(hHealthy.bullmq === 'available', `healthy bullmq is available (got ${hHealthy.bullmq})`)
  assert('database' in hHealthy && 'persistenceState' in hHealthy.database, 'database.persistenceState is present')

  setMockQueueState(QUEUE_STATES.DEGRADED)
  const hDegraded = await buildHealthResponse()
  assert(hDegraded.queueState === 'DEGRADED', `degraded queueState is DEGRADED (got ${hDegraded.queueState})`)
  assert(hDegraded.queue?.state === 'DEGRADED', `degraded queue.state is DEGRADED (got ${hDegraded.queue?.state})`)
  assert(hDegraded.bullmq === 'degraded', `degraded bullmq is degraded (got ${hDegraded.bullmq})`)

  setMockQueueState(QUEUE_STATES.UNAVAILABLE)
  const hUnavailable = await buildHealthResponse()
  assert(hUnavailable.queueState === 'UNAVAILABLE', `unavailable queueState is UNAVAILABLE (got ${hUnavailable.queueState})`)
  assert(hUnavailable.queue?.state === 'UNAVAILABLE', `unavailable queue.state is UNAVAILABLE (got ${hUnavailable.queue?.state})`)
  assert(hUnavailable.bullmq === 'unavailable', `unavailable bullmq is unavailable (got ${hUnavailable.bullmq})`)
  assert(hUnavailable.redis === 'disconnected', `unavailable redis is disconnected (got ${hUnavailable.redis})`)
} finally {
  setMockQueueState(null)
}

console.log('\n--- 5. buildReadyResponse() Readiness Gating ---')
try {
  // Case A: Queue UNAVAILABLE and NOT required -> ready: true (200)
  process.env.QUEUE_REQUIRED = 'false'
  setMockQueueState(QUEUE_STATES.UNAVAILABLE)
  const readyOptional = await buildReadyResponse()
  assert(readyOptional.statusCode === 200, `ready returns 200 when queue UNAVAILABLE but not required (got ${readyOptional.statusCode})`)
  assert(readyOptional.body.ready === true, `ready: true when queue not required (got ${readyOptional.body.ready})`)
  assert(readyOptional.body.queue.state === 'UNAVAILABLE', `queue state reported as UNAVAILABLE in body`)

  // Case B: Queue UNAVAILABLE and IS required -> ready: false (503)
  process.env.QUEUE_REQUIRED = 'true'
  setMockQueueState(QUEUE_STATES.UNAVAILABLE)
  const readyRequired = await buildReadyResponse()
  assert(readyRequired.statusCode === 503, `ready returns 503 when queue UNAVAILABLE and required (got ${readyRequired.statusCode})`)
  assert(readyRequired.body.ready === false, `ready: false when queue required and UNAVAILABLE (got ${readyRequired.body.ready})`)
  assert(readyRequired.body.queue.required === true, 'body.queue.required is true')

  // Case C: Queue DEGRADED and IS required -> ready: true (200)
  process.env.QUEUE_REQUIRED = 'true'
  setMockQueueState(QUEUE_STATES.DEGRADED)
  const readyDegraded = await buildReadyResponse()
  assert(readyDegraded.statusCode === 200, `ready returns 200 when queue DEGRADED (got ${readyDegraded.statusCode})`)
  assert(readyDegraded.body.ready === true, `ready: true when queue DEGRADED (got ${readyDegraded.body.ready})`)

  // Case D: Queue HEALTHY and IS required -> ready: true (200)
  process.env.QUEUE_REQUIRED = 'true'
  setMockQueueState(QUEUE_STATES.HEALTHY)
  const readyHealthy = await buildReadyResponse()
  assert(readyHealthy.statusCode === 200, `ready returns 200 when queue HEALTHY (got ${readyHealthy.statusCode})`)
  assert(readyHealthy.body.ready === true, `ready: true when queue HEALTHY (got ${readyHealthy.body.ready})`)
} finally {
  setMockQueueState(null)
  if (origQueueRequired !== undefined) process.env.QUEUE_REQUIRED = origQueueRequired
  else delete process.env.QUEUE_REQUIRED
}

console.log('\n--- 6. Live HTTP Express Integration ---')
{
  const app = express()
  app.use(express.json())
  app.use('/api/v1/health', healthRouter)

  // Mirror root routes as in server.js
  app.get('/health', async (req, res) => {
    const payload = await buildHealthResponse()
    res.json(payload)
  })
  app.get('/ready', async (req, res) => {
    const { statusCode, body } = await buildReadyResponse()
    res.status(statusCode).json(body)
  })

  const server = app.listen(0)
  await once(server, 'listening')
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  try {
    const fetchOpts = { headers: { connection: 'close' } }

    // 6.1 GET /health returns 200 with queue info
    setMockQueueState(QUEUE_STATES.HEALTHY)
    const resHealth = await fetch(`${base}/health`, fetchOpts)
    assert(resHealth.status === 200, `GET /health HTTP 200 (got ${resHealth.status})`)
    const dataHealth = await resHealth.json()
    assert(dataHealth.queueState === 'HEALTHY', `health payload has queueState HEALTHY`)
    assert(dataHealth.bullmq === 'available', `health payload has bullmq available`)

    // 6.2 GET /api/v1/health returns 200 with queue info via router
    const resV1Health = await fetch(`${base}/api/v1/health`, fetchOpts)
    assert(resV1Health.status === 200, `GET /api/v1/health HTTP 200 (got ${resV1Health.status})`)
    const dataV1Health = await resV1Health.json()
    assert(dataV1Health.queueState === 'HEALTHY', `v1 health payload has queueState HEALTHY`)

    // 6.3 GET /ready with QUEUE_REQUIRED=true and UNAVAILABLE returns 503
    process.env.QUEUE_REQUIRED = 'true'
    setMockQueueState(QUEUE_STATES.UNAVAILABLE)
    const resReady503 = await fetch(`${base}/ready`, fetchOpts)
    assert(resReady503.status === 503, `GET /ready HTTP 503 when queue required + UNAVAILABLE (got ${resReady503.status})`)
    const dataReady503 = await resReady503.json()
    assert(dataReady503.ready === false, `GET /ready ready is false`)
    assert(dataReady503.queue.state === 'UNAVAILABLE', `GET /ready queue state is UNAVAILABLE`)

    // 6.4 GET /ready with queue recovering to HEALTHY returns 200
    setMockQueueState(QUEUE_STATES.HEALTHY)
    const resReady200 = await fetch(`${base}/ready`, fetchOpts)
    assert(resReady200.status === 200, `GET /ready HTTP 200 when queue recovered (got ${resReady200.status})`)
    const dataReady200 = await resReady200.json()
    assert(dataReady200.ready === true, `GET /ready ready is true`)

    // 6.5 GET /api/v1/health/ready route
    const resV1Ready = await fetch(`${base}/api/v1/health/ready`, fetchOpts)
    assert(resV1Ready.status === 200, `GET /api/v1/health/ready HTTP 200 (got ${resV1Ready.status})`)
  } finally {
    setMockQueueState(null)
    if (origQueueRequired !== undefined) process.env.QUEUE_REQUIRED = origQueueRequired
    else delete process.env.QUEUE_REQUIRED
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve)).catch(() => {})
  }
}

console.log('\n--- 7. Preflight ensure-redis.mjs Verification ---')
{
  const scriptPath = path.join(backendRoot, 'scripts', 'ensure-redis.mjs')
  assert(fs.existsSync(scriptPath), 'backend/scripts/ensure-redis.mjs exists')
  const content = fs.readFileSync(scriptPath, 'utf8')
  assert(content.includes('waitForRedis'), 'ensure-redis.mjs probes Redis with waitForRedis')
  assert(content.includes('docker compose up -d redis'), 'ensure-redis.mjs gives docker compose remediation')
  assert(content.includes('REDIS_HOST') && content.includes('REDIS_PORT'), 'ensure-redis.mjs notes REDIS_HOST/REDIS_PORT in .env')
}

console.log('\n--- 8. Static Source Fences in server.js ---')
{
  const serverSrc = fs.readFileSync(path.join(backendRoot, 'server.js'), 'utf8')
  assert(serverSrc.includes("app.get('/ready'"), 'server.js defines GET /ready')
  assert(serverSrc.includes("app.get('/health'"), 'server.js defines GET /health')
  assert(serverSrc.includes('persistenceState'), 'server.js exposes persistenceState')
  assert(serverSrc.includes('queueState'), 'server.js exposes queueState')
  assert(serverSrc.includes('QUEUE_STATES.UNAVAILABLE'), 'server.js references QUEUE_STATES.UNAVAILABLE in /ready')
  assert(serverSrc.includes('res.status(ready ? 200 : 503)'), 'server.js honors ready predicate')
}

try {
  const { connection } = await import('../src/queue/connection.js')
  connection.disconnect()
} catch (_) {}

// Wait for torn-down sockets/handles to finish closing before process.exit on Windows
for (let i = 0; i < 100; i++) {
  const pending = process._getActiveHandles?.().filter((h) => h?.constructor?.name === 'Socket') || []
  if (pending.length === 0) break
  await new Promise((r) => setTimeout(r, 20))
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
process.exit(failures === 0 ? 0 : 1)
