// Persistence health: real PostgreSQL probe/write failures drive
// HEALTHY -> DEGRADED -> WRITE_BLOCKED (DB_MAX_SAVE_FAILURES), mutations are
// rejected with PersistenceBlockedError while blocked, reads stay available,
// unwritable temp dirs never affect PostgreSQL persistence health, and recovery
// restores HEALTHY when PostgreSQL responds again.
// Run: node backend/tests/persistenceHealth.test.mjs
process.env.NODE_ENV = 'test'
process.env.DB_MAX_SAVE_FAILURES = '3'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const { initSchema } = await import('../src/db/schema.js')
const {
  getPool,
  closePool,
  save,
  probeDatabaseHealth,
  getDbPersistenceHealth,
  PERSISTENCE_STATES,
} = await import('../src/db.js')
const {
  run,
  queryOne,
  withTransaction,
  PersistenceBlockedError,
} = await import('../src/db/query.js')
const {
  buildHealthResponse,
  buildReadyResponse,
} = await import('../src/routes/v1/health.js')
const { connection } = await import('../src/queue/connection.js')
try { connection.disconnect() } catch (_) {}

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

await run('DELETE FROM settings WHERE user_id LIKE ?', ['ph-%']).catch(() => {})
await run('DELETE FROM users WHERE id LIKE ?', ['ph-%']).catch(() => {})
for (const uid of ['ph-unwritable', 'ph-attempted', 'ph-blocked', 'ph-recovered', 'ph-readonly']) {
  await run('INSERT INTO users (id, email, password) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [uid, `${uid}@test.local`, 'pw'])
}

let health = getDbPersistenceHealth()
assert(health.state === PERSISTENCE_STATES.HEALTHY, `starts HEALTHY (got ${health.state})`)
assert(health.maxSaveFailures === 3, `threshold honours DB_MAX_SAVE_FAILURES (got ${health.maxSaveFailures})`)

// 0. Source fence: db.js performs zero filesystem writes / temp-dir probes.
{
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8')
  assert(!dbSrc.includes('writeFileSync'), 'db.js contains no fs.writeFileSync')
  assert(!dbSrc.includes('.vidai_db_probe'), 'db.js contains no .vidai_db_probe temp file')
}

// 1. Unwritable / inaccessible temp dir while PostgreSQL is healthy -> stays HEALTHY.
{
  const originalWriteFileSync = fs.writeFileSync
  const originalTmpdir = os.tmpdir
  let writeAttempts = 0
  fs.writeFileSync = () => {
    writeAttempts += 1
    const error = new Error('EACCES: simulated unwritable temp dir')
    error.code = 'EACCES'
    throw error
  }
  os.tmpdir = () => path.join(__dirname, '__nonexistent_unwritable_tmp__', 'nested')
  try {
    await save()
    await run('INSERT INTO settings (user_id) VALUES (?) ON CONFLICT DO NOTHING', ['ph-unwritable'])
    const h = await probeDatabaseHealth()
    const healthResp = await buildHealthResponse()
    const readyResp = await buildReadyResponse()
    assert(writeAttempts === 0, `DB save/writes perform zero fs.writeFileSync calls (got ${writeAttempts})`)
    assert(h.state === PERSISTENCE_STATES.HEALTHY && h.consecutiveSaveFailures === 0,
      `unwritable temp dir keeps persistenceState HEALTHY (got ${h.state}/${h.consecutiveSaveFailures})`)
    assert(healthResp.status === 'ok' && healthResp.database?.persistenceState === PERSISTENCE_STATES.HEALTHY,
      `/health stays ok/HEALTHY with unwritable temp dir (got ${healthResp.status}/${healthResp.database?.persistenceState})`)
    assert(readyResp.statusCode === 200 && readyResp.body?.ready === true,
      `/ready stays 200 ready:true with unwritable temp dir (got ${readyResp.statusCode}/${readyResp.body?.ready})`)
  } finally {
    fs.writeFileSync = originalWriteFileSync
    os.tmpdir = originalTmpdir
  }
}

// 2. Simulated PostgreSQL outage / probe & write failures:
//    HEALTHY -> DEGRADED -> WRITE_BLOCKED, reads stay unblocked by gate, recovery -> HEALTHY.
const pool = getPool()
const originalPoolQuery = pool.query.bind(pool)
let failPgWritesAndProbe = false

pool.query = async (sql, ...rest) => {
  const text = typeof sql === 'string' ? sql : sql?.text || ''
  if (failPgWritesAndProbe) {
    const isProbe = /^\s*SELECT\s+1\s*;?\s*$/i.test(text)
    const isReadCheck = /^\s*SELECT\s+1\s+AS\s+ok\b/i.test(text)
    if (isProbe || (!isReadCheck && !/^\s*SELECT\b/i.test(text))) {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:5433')
      error.code = 'ECONNREFUSED'
      throw error
    }
  }
  return originalPoolQuery(sql, ...rest)
}

try {
  failPgWritesAndProbe = true

  // 2a. First probe failure -> DEGRADED (1/3).
  try { await save() } catch (_) {}
  health = getDbPersistenceHealth()
  assert(health.state === PERSISTENCE_STATES.DEGRADED && health.consecutiveSaveFailures === 1,
    `first PostgreSQL probe failure degrades (got ${health.state}/${health.consecutiveSaveFailures})`)

  // 2b. Mutation below threshold is attempted and fails with raw PostgreSQL error.
  let rawError = null
  try { await run('INSERT INTO settings (user_id) VALUES (?)', ['ph-attempted']) } catch (e) { rawError = e }
  assert(rawError && rawError.name !== 'PersistenceBlockedError' && rawError.code === 'ECONNREFUSED',
    `below threshold a write is attempted and fails with the PostgreSQL error (got: ${rawError?.name}/${rawError?.code})`)
  health = getDbPersistenceHealth()
  assert(health.consecutiveSaveFailures === 2, `failed write counts toward threshold (got ${health.consecutiveSaveFailures})`)

  // 2c. Reach threshold (3/3) -> WRITE_BLOCKED; /health -> unavailable, /ready -> 503.
  try { await save() } catch (_) {}
  health = getDbPersistenceHealth()
  assert(health.state === PERSISTENCE_STATES.WRITE_BLOCKED && health.consecutiveSaveFailures === 3,
    `threshold reached -> WRITE_BLOCKED (got ${health.state}/${health.consecutiveSaveFailures})`)

  const healthBlocked = await buildHealthResponse()
  assert(healthBlocked.status === 'unavailable' && healthBlocked.database?.persistenceState === PERSISTENCE_STATES.WRITE_BLOCKED,
    `/health reports unavailable/WRITE_BLOCKED when PG unreachable (got ${healthBlocked.status}/${healthBlocked.database?.persistenceState})`)
  const readyBlocked = await buildReadyResponse()
  assert(readyBlocked.statusCode === 503 && readyBlocked.body?.ready === false && readyBlocked.body?.database?.persistenceState === PERSISTENCE_STATES.WRITE_BLOCKED,
    `/ready returns 503 ready:false when WRITE_BLOCKED (got ${readyBlocked.statusCode}/${readyBlocked.body?.ready})`)

  // 2d. Reads stay available (not blocked by persistence gate).
  const probe = await queryOne('SELECT 1 AS ok')
  assert(probe?.ok === 1, 'reads are never blocked by persistence policy')

  // 2e. Mutations are rejected with PersistenceBlockedError (503 semantics).
  let blockedError = null
  try { await run('INSERT INTO settings (user_id) VALUES (?)', ['ph-blocked']) } catch (e) { blockedError = e }
  assert(blockedError instanceof PersistenceBlockedError,
    `blocked mutation throws PersistenceBlockedError (got: ${blockedError?.name}/${blockedError?.code})`)
  assert(blockedError?.code === 'DB_PERSISTENCE_BLOCKED' && blockedError?.statusCode === 503,
    'blocked mutation carries DB_PERSISTENCE_BLOCKED with 503')
} finally {
  failPgWritesAndProbe = false
  pool.query = originalPoolQuery
}

// 3. PostgreSQL recovers -> next mutation probes save(), restores HEALTHY, and proceeds.
const recovered = await run('INSERT INTO settings (user_id) VALUES (?) ON CONFLICT DO NOTHING', ['ph-recovered'])
health = getDbPersistenceHealth()
assert(recovered === true && health.state === PERSISTENCE_STATES.HEALTHY,
  `recovery probe restores HEALTHY (got ${health.state})`)
assert(health.consecutiveSaveFailures === 0 && health.lastSuccessfulSaveAt !== null && health.lastSaveError === null,
  'recovery resets failure counter, clears lastSaveError, and updates lastSuccessfulSaveAt')
const row = await queryOne('SELECT user_id FROM settings WHERE user_id = ?', ['ph-recovered'])
assert(row?.user_id === 'ph-recovered', 'write proceeds after recovery')
const readyRecovered = await buildReadyResponse()
assert(readyRecovered.statusCode === 200 && readyRecovered.body?.ready === true,
  `/ready recovers to 200 ready:true (got ${readyRecovered.statusCode}/${readyRecovered.body?.ready})`)

// 4. Write-only PostgreSQL error (25006 read_only_sql_transaction) degrades /health while SELECT 1 stays up;
//    normal constraint/app errors do NOT trigger DEGRADED.
{
  // 4a. Non-persistence constraint violation (23505) must NOT count as persistence failure.
  let constraintErr = null
  try {
    await run('INSERT INTO users (id, email, password) VALUES (?, ?, ?)', ['ph-recovered', 'ph-recovered@test.local', 'pw'])
  } catch (e) { constraintErr = e }
  assert(constraintErr?.code === '23505', `duplicate PK raises 23505 (got ${constraintErr?.code})`)
  assert(getDbPersistenceHealth().state === PERSISTENCE_STATES.HEALTHY && getDbPersistenceHealth().consecutiveSaveFailures === 0,
    'SQL constraint error (23505) does not degrade persistence health')

  // 4b. Business error thrown inside withTransaction must NOT count as persistence failure.
  let bizErr = null
  try {
    await withTransaction(async () => {
      throw new Error('business validation failed')
    })
  } catch (e) { bizErr = e }
  assert(bizErr?.message === 'business validation failed', 'app error propagates from withTransaction')
  assert(getDbPersistenceHealth().consecutiveSaveFailures === 0,
    'application error inside withTransaction does not increment failure counter')

  // 4c. Simulated 25006 read_only_sql_transaction write failure drives DEGRADED and /health reflects it.
  pool.query = async (sql, ...rest) => {
    const text = typeof sql === 'string' ? sql : sql?.text || ''
    if (/^\s*INSERT\b/i.test(text)) {
      const error = new Error('cannot execute INSERT in a read-only transaction')
      error.code = '25006'
      throw error
    }
    return originalPoolQuery(sql, ...rest)
  }
  try {
    await run('INSERT INTO settings (user_id) VALUES (?)', ['ph-readonly']).catch(() => {})
  } finally {
    pool.query = originalPoolQuery
  }
  const healthAfterReadonly = await buildHealthResponse()
  assert(healthAfterReadonly.status === 'degraded' && healthAfterReadonly.database?.persistenceState === PERSISTENCE_STATES.DEGRADED,
    `/health preserves DEGRADED after write failure 25006 (got ${healthAfterReadonly.status}/${healthAfterReadonly.database?.persistenceState})`)

  // Clean write recovers back to HEALTHY.
  await run('INSERT INTO settings (user_id) VALUES (?) ON CONFLICT DO NOTHING', ['ph-readonly'])
  assert(getDbPersistenceHealth().state === PERSISTENCE_STATES.HEALTHY, 'successful write recovers from write-only DEGRADED')
}

// 5. Source fences: blocked writes surface as 503 at routes and as a transient park inside the pipeline.
{
  const readSrc = (...parts) => fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8')
  const projectsRoute = readSrc('routes', 'v1', 'projects.js')
  assert(projectsRoute.includes('DB_PERSISTENCE_BLOCKED'), 'project routes map persistence blocks to 503')
  const dubDataRoute = readSrc('routes', 'v1', 'dubData.js')
  assert(dubDataRoute.includes('DB_PERSISTENCE_BLOCKED'), 'transcript routes map persistence blocks to 503')
  const runnerSrc = readSrc('pipeline', 'runner.js')
  assert(runnerSrc.includes("err?.code === 'DB_PERSISTENCE_BLOCKED'"), 'pipeline treats persistence blocks as transient')
  assert(runnerSrc.includes('Không thể đánh dấu failed'), 'pipeline survives a blocked failure write')
}

await run('DELETE FROM settings WHERE user_id LIKE ?', ['ph-%']).catch(() => {})
await run('DELETE FROM users WHERE id LIKE ?', ['ph-%']).catch(() => {})
await closePool()
if (failures > 0) process.exit(1)
console.log('ALL PASS')
