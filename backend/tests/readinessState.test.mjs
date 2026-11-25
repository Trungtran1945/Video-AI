// Health/readiness persistence exposure (Issue J):
// - getDbPersistenceHealth exposes HEALTHY/DEGRADED/WRITE_BLOCKED + counters
// - server.js /health reports persistenceState; /ready returns 503+ready:false
//   on WRITE_BLOCKED (decision 3.A), 200+ready:true otherwise
// - live boot probe: /health + /ready return persistenceState HEALTHY without DB_PATH
// - unwritable temp dir keeps HEALTHY; PostgreSQL probe failure drives DEGRADED/WRITE_BLOCKED and recovery restores HEALTHY
// Run: node backend/tests/readinessState.test.mjs
process.env.NODE_ENV = 'test'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// ── 1) static fences: routes exist with the right semantics ──
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
  assert(src.includes("app.get('/ready'"), 'server.js defines GET /ready')
  assert(src.includes('WRITE_BLOCKED') && src.includes('503'), '/ready maps WRITE_BLOCKED to 503')
  assert(src.includes('persistenceState'), '/health exposes persistenceState')
  assert(src.includes('consecutiveSaveFailures'), 'health exposes consecutiveSaveFailures')
  assert(src.includes('lastSuccessfulSaveAt'), 'health exposes lastSuccessfulSaveAt')
  assert(/res\.status\(ready \? 200 : 503\)/.test(src), '/ready status honors readiness predicate')
}

// ── 2) live boot probe on PostgreSQL with isolated STORAGE_DIR ──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-ready-'))
const port = 32179
const child = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env,
    STORAGE_DIR: path.join(tmpRoot, 'storage'),
    NODE_ENV: 'test',
    PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (d) => { out += String(d) })
child.stderr.on('data', (d) => { out += String(d) })

const waitFor = async (fn, timeoutMs, label) => {
  const start = Date.now()
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (_) {}
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

try {
  const health = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/health`)
    if (!r.ok && r.status !== 503) return null
    return r.json()
  }, 25000, 'server boot')
  assert(health?.database?.persistenceState === 'HEALTHY',
    `live /health persistenceState HEALTHY (got ${health?.database?.persistenceState})`)
  assert(health?.database?.engine === 'postgresql',
    `live /health engine postgresql (got ${health?.database?.engine})`)
  assert(typeof health?.database?.consecutiveSaveFailures === 'number', '/health has consecutiveSaveFailures')
  assert('lastSuccessfulSaveAt' in (health?.database || {}), '/health has lastSuccessfulSaveAt')

  const readyRes = await fetch(`http://127.0.0.1:${port}/ready`)
  const ready = await readyRes.json()
  assert(readyRes.status === 200 && ready?.ready === true,
    `live /ready 200 ready:true when HEALTHY (got ${readyRes.status}/${ready?.ready})`)
  assert(ready?.database?.persistenceState === 'HEALTHY', '/ready reports persistenceState')
} catch (e) {
  failures++
  console.error('FAIL: live probe threw —', e?.message || e)
  console.error('--- server output ---\n' + out.slice(-3000))
} finally {
  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 1500))
  try { child.kill('SIGKILL') } catch (_) {}
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

// ── 3) /health & /ready PostgreSQL outage -> DEGRADED -> WRITE_BLOCKED -> recovery ──
{
  const origMax = process.env.DB_MAX_SAVE_FAILURES
  process.env.DB_MAX_SAVE_FAILURES = '2'
  const { getPool, closePool, PERSISTENCE_STATES } = await import('../src/db.js')
  const { buildHealthResponse, buildReadyResponse } = await import('../src/routes/v1/health.js')
  const { connection } = await import('../src/queue/connection.js')
  try { connection.disconnect() } catch (_) {}

  const pool = getPool()
  const origQuery = pool.query.bind(pool)
  const origWriteFileSync = fs.writeFileSync
  let failProbe = false

  // Temp dir write errors must never affect /health or /ready while PostgreSQL is OK.
  fs.writeFileSync = () => {
    const err = new Error('EACCES: unwritable temp dir')
    err.code = 'EACCES'
    throw err
  }
  pool.query = async (sql, ...rest) => {
    const text = typeof sql === 'string' ? sql : sql?.text || ''
    if (failProbe && /^\s*SELECT\s+1\b/i.test(text)) {
      const err = new Error('ECONNREFUSED: simulated PostgreSQL outage')
      err.code = 'ECONNREFUSED'
      throw err
    }
    return origQuery(sql, ...rest)
  }

  try {
    const hOk = await buildHealthResponse()
    const rOk = await buildReadyResponse()
    assert(hOk.status === 'ok' && hOk.database?.persistenceState === PERSISTENCE_STATES.HEALTHY,
      `buildHealthResponse HEALTHY with unwritable temp dir (got ${hOk.status}/${hOk.database?.persistenceState})`)
    assert(rOk.statusCode === 200 && rOk.body?.ready === true,
      `buildReadyResponse 200 with unwritable temp dir (got ${rOk.statusCode}/${rOk.body?.ready})`)

    failProbe = true
    const hDeg = await buildHealthResponse()
    assert(hDeg.status === 'degraded' && hDeg.database?.persistenceState === PERSISTENCE_STATES.DEGRADED,
      `1st PG probe failure -> /health degraded/DEGRADED (got ${hDeg.status}/${hDeg.database?.persistenceState})`)

    const rBlk = await buildReadyResponse()
    assert(rBlk.statusCode === 503 && rBlk.body?.ready === false && rBlk.body?.database?.persistenceState === PERSISTENCE_STATES.WRITE_BLOCKED,
      `2nd PG probe failure -> /ready 503 WRITE_BLOCKED (got ${rBlk.statusCode}/${rBlk.body?.ready}/${rBlk.body?.database?.persistenceState})`)

    failProbe = false
    const rRec = await buildReadyResponse()
    const hRec = await buildHealthResponse()
    assert(rRec.statusCode === 200 && rRec.body?.ready === true && rRec.body?.database?.persistenceState === PERSISTENCE_STATES.HEALTHY,
      `/ready recovers to 200 HEALTHY when PG recovers (got ${rRec.statusCode}/${rRec.body?.database?.persistenceState})`)
    assert(hRec.status === 'ok' && hRec.database?.consecutiveSaveFailures === 0,
      `/health recovers to ok/0 failures (got ${hRec.status}/${hRec.database?.consecutiveSaveFailures})`)
  } finally {
    failProbe = false
    fs.writeFileSync = origWriteFileSync
    pool.query = origQuery
    if (origMax !== undefined) process.env.DB_MAX_SAVE_FAILURES = origMax
    else delete process.env.DB_MAX_SAVE_FAILURES
    await closePool()
  }
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
process.exit(failures === 0 ? 0 : 1)
