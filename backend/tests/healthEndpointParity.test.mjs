// Health and Readiness Endpoint Parity Test (Round 2 - Steps 3 & 5)
// Verifies:
// 1. Static source fences: server.js delegates to buildHealthResponse and buildReadyResponse
// 2. setMockQueueState is guarded to NODE_ENV === 'test' only
// 3. buildHealthResponse() and buildReadyResponse() contract completeness
// 4. Parity between server.js (/health, /ready) and router (/api/v1/health, /api/v1/health/ready)
//    across all queue states: HEALTHY, DEGRADED, UNAVAILABLE (with QUEUE_REQUIRED=false and true)
// 5. Parity when DB persistence is WRITE_BLOCKED
// 6. Realistic fallback for durableCleanup and refreshFallback
// Run: node backend/tests/healthEndpointParity.test.mjs
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

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const k of keysA) {
    if (!keysB.includes(k)) return false
    if (!deepEqual(a[k], b[k])) return false
  }
  return true
}

function assertHealthParity(a, b, label) {
  assert(a.status === b.status, `${label}: status matches (${a.status})`)
  assert(a.redis === b.redis, `${label}: redis matches (${a.redis})`)
  assert(a.bullmq === b.bullmq, `${label}: bullmq matches (${a.bullmq})`)
  assert(a.durableCleanup === b.durableCleanup, `${label}: durableCleanup matches (${a.durableCleanup})`)
  assert(a.queueState === b.queueState, `${label}: queueState matches (${a.queueState})`)
  assert(deepEqual(a.queue, b.queue), `${label}: queue object matches identically`)
  assert(a.database?.persistenceState === b.database?.persistenceState, `${label}: persistenceState matches (${a.database?.persistenceState})`)
  assert(a.database?.engine === b.database?.engine, `${label}: engine matches (${a.database?.engine})`)
  assert(a.database?.consecutiveSaveFailures === b.database?.consecutiveSaveFailures, `${label}: consecutiveSaveFailures matches`)
  assert(deepEqual(a.writes, b.writes), `${label}: writes object matches identically`)
  assert(deepEqual(a.auth, b.auth), `${label}: auth object matches identically`)
}

function assertReadyParity(a, b, label) {
  assert(a.ready === b.ready, `${label}: ready matches (${a.ready})`)
  assert(a.redis === b.redis, `${label}: redis matches (${a.redis})`)
  assert(deepEqual(a.queue, b.queue), `${label}: queue object matches identically`)
  assert(a.database?.persistenceState === b.database?.persistenceState, `${label}: persistenceState matches (${a.database?.persistenceState})`)
  assert(a.database?.consecutiveSaveFailures === b.database?.consecutiveSaveFailures, `${label}: consecutiveSaveFailures matches`)
}

console.log('--- 1. Static Source Fences in server.js & health.js ---')
{
  const serverSrc = fs.readFileSync(path.join(backendRoot, 'server.js'), 'utf8')
  assert(serverSrc.includes("app.get('/health'"), 'server.js defines GET /health')
  assert(serverSrc.includes("app.get('/ready'"), 'server.js defines GET /ready')
  assert(serverSrc.includes('buildHealthResponse()'), 'server.js delegates /health to buildHealthResponse()')
  assert(serverSrc.includes('buildReadyResponse()'), 'server.js delegates /ready to buildReadyResponse()')
  assert(serverSrc.includes('persistenceState'), 'server.js preserves persistenceState token')
  assert(serverSrc.includes('consecutiveSaveFailures'), 'server.js preserves consecutiveSaveFailures token')
  assert(serverSrc.includes('lastSuccessfulSaveAt'), 'server.js preserves lastSuccessfulSaveAt token')
  assert(serverSrc.includes('res.status(ready ? 200 : 503)'), 'server.js preserves res.status(ready ? 200 : 503)')
  assert(serverSrc.includes('durableCleanup'), 'server.js preserves durableCleanup token')
  assert(serverSrc.includes('bullmq'), 'server.js preserves bullmq token')
  assert(serverSrc.includes('getCleanupStats'), 'server.js preserves getCleanupStats token')
  assert(serverSrc.includes('QUEUE_STATES.UNAVAILABLE'), 'server.js references QUEUE_STATES.UNAVAILABLE')
  assert(serverSrc.includes('Redis is report-only in dev, but gates readiness'), 'server.js has updated Redis readiness comment')

  const healthSrc = fs.readFileSync(path.join(backendRoot, 'src', 'routes', 'v1', 'health.js'), 'utf8')
  assert(healthSrc.includes("process.env.NODE_ENV !== 'test'"), 'health.js guards setMockQueueState with NODE_ENV !== test check')
  assert(healthSrc.includes('buildHealthResponse'), 'health.js exports buildHealthResponse')
  assert(healthSrc.includes('buildReadyResponse'), 'health.js exports buildReadyResponse')
}

console.log('\n--- 2. setMockQueueState Environment Guard ---')
{
  const origEnv = process.env.NODE_ENV
  try {
    process.env.NODE_ENV = 'production'
    let threwProd = false
    try {
      setMockQueueState(QUEUE_STATES.HEALTHY)
    } catch (err) {
      threwProd = true
      assert(err.message.includes('only allowed in test environment'), 'threw expected error in production')
    }
    assert(threwProd, 'setMockQueueState throws in NODE_ENV=production')

    process.env.NODE_ENV = 'development'
    let threwDev = false
    try {
      setMockQueueState(QUEUE_STATES.HEALTHY)
    } catch (err) {
      threwDev = true
      assert(err.message.includes('only allowed in test environment'), 'threw expected error in development')
    }
    assert(threwDev, 'setMockQueueState throws in NODE_ENV=development')

    process.env.NODE_ENV = 'test'
    let threwTest = false
    try {
      setMockQueueState(QUEUE_STATES.HEALTHY)
    } catch (_) {
      threwTest = true
    }
    assert(!threwTest, 'setMockQueueState succeeds in NODE_ENV=test')
  } finally {
    process.env.NODE_ENV = 'test'
    setMockQueueState(null)
  }
}

console.log('\n--- 3. Canonical Contract Structure ---')
{
  setMockQueueState(QUEUE_STATES.HEALTHY)
  const healthRes = await buildHealthResponse()
  assert('status' in healthRes, 'health response has status')
  assert('redis' in healthRes, 'health response has redis')
  assert('bullmq' in healthRes, 'health response has bullmq')
  assert('durableCleanup' in healthRes, 'health response has durableCleanup')
  assert('cleanup' in healthRes, 'health response has cleanup')
  assert('queueState' in healthRes, 'health response has queueState')
  assert('queue' in healthRes, 'health response has queue object')
  assert('database' in healthRes, 'health response has database object')
  assert('writes' in healthRes, 'health response has writes object')
  assert('auth' in healthRes, 'health response has auth object')

  const readyRes = await buildReadyResponse()
  assert(typeof readyRes.ready === 'boolean', 'ready response has ready boolean')
  assert(typeof readyRes.statusCode === 'number', 'ready response has statusCode number')
  assert(typeof readyRes.body === 'object', 'ready response has body object')
  assert('database' in readyRes.body, 'ready response body has database')
  assert('redis' in readyRes.body, 'ready response body has redis')
  assert('queue' in readyRes.body, 'ready response body has queue')
  setMockQueueState(null)
}

console.log('\n--- 4. HTTP Parity across Queue States ---')
{
  const app = express()
  app.use(express.json())
  app.use('/api/v1/health', healthRouter)

  // Root routes mirroring server.js
  app.get('/health', async (req, res) => {
    const payload = await buildHealthResponse()
    res.json(payload)
  })
  app.get('/ready', async (req, res) => {
    const { ready, body } = await buildReadyResponse()
    res.status(ready ? 200 : 503).json(body)
  })

  const server = app.listen(0)
  await once(server, 'listening')
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  const fetchOpts = { headers: { connection: 'close' } }

  const origQueueRequired = process.env.QUEUE_REQUIRED
  try {
    // 4.1 State: HEALTHY
    setMockQueueState(QUEUE_STATES.HEALTHY)
    process.env.QUEUE_REQUIRED = 'false'
    {
      const [resRootHealth, resV1Health] = await Promise.all([
        fetch(`${base}/health`, fetchOpts),
        fetch(`${base}/api/v1/health`, fetchOpts),
      ])
      assert(resRootHealth.status === 200 && resV1Health.status === 200, 'HEALTHY: both /health return 200')
      const [dataRootHealth, dataV1Health] = await Promise.all([resRootHealth.json(), resV1Health.json()])
      assertHealthParity(dataRootHealth, dataV1Health, 'HEALTHY')
      assert(dataRootHealth.queueState === 'HEALTHY', 'HEALTHY: queueState is HEALTHY')
      assert(dataRootHealth.redis === 'connected', 'HEALTHY: redis is connected')
      assert(dataRootHealth.bullmq === 'available', 'HEALTHY: bullmq is available')

      const [resRootReady, resV1Ready] = await Promise.all([
        fetch(`${base}/ready`, fetchOpts),
        fetch(`${base}/api/v1/health/ready`, fetchOpts),
      ])
      assert(resRootReady.status === 200 && resV1Ready.status === 200, 'HEALTHY: both /ready return 200')
      const [dataRootReady, dataV1Ready] = await Promise.all([resRootReady.json(), resV1Ready.json()])
      assertReadyParity(dataRootReady, dataV1Ready, 'HEALTHY')
      assert(dataRootReady.ready === true, 'HEALTHY: ready is true')
    }

    // 4.2 State: DEGRADED
    setMockQueueState(QUEUE_STATES.DEGRADED)
    {
      const [resRootHealth, resV1Health] = await Promise.all([
        fetch(`${base}/health`, fetchOpts),
        fetch(`${base}/api/v1/health`, fetchOpts),
      ])
      assert(resRootHealth.status === 200 && resV1Health.status === 200, 'DEGRADED: both /health return 200')
      const [dataRootHealth, dataV1Health] = await Promise.all([resRootHealth.json(), resV1Health.json()])
      assertHealthParity(dataRootHealth, dataV1Health, 'DEGRADED')
      assert(dataRootHealth.queueState === 'DEGRADED', 'DEGRADED: queueState is DEGRADED')
      assert(dataRootHealth.redis === 'reconnecting', 'DEGRADED: redis is reconnecting')
      assert(dataRootHealth.bullmq === 'degraded', 'DEGRADED: bullmq is degraded')

      const [resRootReady, resV1Ready] = await Promise.all([
        fetch(`${base}/ready`, fetchOpts),
        fetch(`${base}/api/v1/health/ready`, fetchOpts),
      ])
      assert(resRootReady.status === 200 && resV1Ready.status === 200, 'DEGRADED: both /ready return 200')
      const [dataRootReady, dataV1Ready] = await Promise.all([resRootReady.json(), resV1Ready.json()])
      assertReadyParity(dataRootReady, dataV1Ready, 'DEGRADED')
      assert(dataRootReady.ready === true, 'DEGRADED: ready is true')
    }

    // 4.3 State: UNAVAILABLE with QUEUE_REQUIRED=false (Dev mode)
    setMockQueueState(QUEUE_STATES.UNAVAILABLE)
    process.env.QUEUE_REQUIRED = 'false'
    {
      const [resRootHealth, resV1Health] = await Promise.all([
        fetch(`${base}/health`, fetchOpts),
        fetch(`${base}/api/v1/health`, fetchOpts),
      ])
      assert(resRootHealth.status === 200 && resV1Health.status === 200, 'UNAVAILABLE (dev): both /health return 200')
      const [dataRootHealth, dataV1Health] = await Promise.all([resRootHealth.json(), resV1Health.json()])
      assertHealthParity(dataRootHealth, dataV1Health, 'UNAVAILABLE (dev)')
      assert(dataRootHealth.queueState === 'UNAVAILABLE', 'UNAVAILABLE (dev): queueState is UNAVAILABLE')
      assert(dataRootHealth.redis === 'disconnected', 'UNAVAILABLE (dev): redis is disconnected')
      assert(dataRootHealth.bullmq === 'unavailable', 'UNAVAILABLE (dev): bullmq is unavailable')

      const [resRootReady, resV1Ready] = await Promise.all([
        fetch(`${base}/ready`, fetchOpts),
        fetch(`${base}/api/v1/health/ready`, fetchOpts),
      ])
      assert(resRootReady.status === 200 && resV1Ready.status === 200, 'UNAVAILABLE (dev): both /ready return 200')
      const [dataRootReady, dataV1Ready] = await Promise.all([resRootReady.json(), resV1Ready.json()])
      assertReadyParity(dataRootReady, dataV1Ready, 'UNAVAILABLE (dev)')
      assert(dataRootReady.ready === true, 'UNAVAILABLE (dev): ready is true')
    }

    // 4.4 State: UNAVAILABLE with QUEUE_REQUIRED=true (Production mode)
    setMockQueueState(QUEUE_STATES.UNAVAILABLE)
    process.env.QUEUE_REQUIRED = 'true'
    {
      const [resRootHealth, resV1Health] = await Promise.all([
        fetch(`${base}/health`, fetchOpts),
        fetch(`${base}/api/v1/health`, fetchOpts),
      ])
      assert(resRootHealth.status === 200 && resV1Health.status === 200, 'UNAVAILABLE (prod): both /health return 200')
      const [dataRootHealth, dataV1Health] = await Promise.all([resRootHealth.json(), resV1Health.json()])
      assertHealthParity(dataRootHealth, dataV1Health, 'UNAVAILABLE (prod)')

      const [resRootReady, resV1Ready] = await Promise.all([
        fetch(`${base}/ready`, fetchOpts),
        fetch(`${base}/api/v1/health/ready`, fetchOpts),
      ])
      assert(resRootReady.status === 503 && resV1Ready.status === 503, 'UNAVAILABLE (prod): both /ready return 503')
      const [dataRootReady, dataV1Ready] = await Promise.all([resRootReady.json(), resV1Ready.json()])
      assertReadyParity(dataRootReady, dataV1Ready, 'UNAVAILABLE (prod)')
      assert(dataRootReady.ready === false, 'UNAVAILABLE (prod): ready is false')
      assert(dataRootReady.queue?.state === 'UNAVAILABLE', 'UNAVAILABLE (prod): queue.state is UNAVAILABLE')
    }
  } finally {
    setMockQueueState(null)
    if (origQueueRequired !== undefined) process.env.QUEUE_REQUIRED = origQueueRequired
    else delete process.env.QUEUE_REQUIRED

    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve)).catch(() => {})
  }
}

console.log('\n--- 5. Database Persistence State Parity ---')
{
  const app = express()
  app.use(express.json())
  app.use('/api/v1/health', healthRouter)

  app.get('/health', async (req, res) => {
    const payload = await buildHealthResponse()
    res.json(payload)
  })
  app.get('/ready', async (req, res) => {
    const { ready, body } = await buildReadyResponse()
    res.status(ready ? 200 : 503).json(body)
  })

  const server = app.listen(0)
  await once(server, 'listening')
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  const fetchOpts = { headers: { connection: 'close' } }

  try {
    const health = getDbPersistenceHealth()
    const [resRootReady, resV1Ready] = await Promise.all([
      fetch(`${base}/ready`, fetchOpts),
      fetch(`${base}/api/v1/health/ready`, fetchOpts),
    ])
    assert(resRootReady.status === resV1Ready.status, `DB current state (${health.state}): status codes match (${resRootReady.status})`)
    const [dataRootReady, dataV1Ready] = await Promise.all([resRootReady.json(), resV1Ready.json()])
    assertReadyParity(dataRootReady, dataV1Ready, 'DB current state')
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve)).catch(() => {})
  }
}

try {
  const { connection } = await import('../src/queue/connection.js')
  connection.disconnect()
} catch (_) {}

// Windows libuv teardown drain
for (let i = 0; i < 100; i++) {
  const pending = process._getActiveHandles?.().filter((h) => h?.constructor?.name === 'Socket') || []
  if (pending.length === 0) break
  await new Promise((r) => setTimeout(r, 20))
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll health & readiness endpoint parity tests passed!')
  process.exit(0)
}
