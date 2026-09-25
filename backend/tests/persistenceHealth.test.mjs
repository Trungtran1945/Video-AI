// Persistence health: consecutive save() failures drive
// HEALTHY → DEGRADED → WRITE_BLOCKED (DB_MAX_SAVE_FAILURES), mutations are
// rejected with PersistenceBlockedError while blocked, reads stay available,
// and a single probe save() restores HEALTHY when the disk recovers.
// Run: node backend/tests/persistenceHealth.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-persistence-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.DB_MAX_SAVE_FAILURES = '3'

const { initSchema } = await import('../src/db/schema.js')
const { save, getDbPersistenceHealth, PERSISTENCE_STATES } = await import('../src/db.js')
const { run, queryOne, PersistenceBlockedError } = await import('../src/db/query.js')

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

let health = getDbPersistenceHealth()
assert(health.state === PERSISTENCE_STATES.HEALTHY, `starts HEALTHY (got ${health.state})`)
assert(health.maxSaveFailures === 3, `threshold honours DB_MAX_SAVE_FAILURES (got ${health.maxSaveFailures})`)

// Simulated disk failure: every save() now throws.
const originalWriteFileSync = fs.writeFileSync
fs.writeFileSync = () => {
  const error = new Error('EACCES: simulated save failure')
  error.code = 'EACCES'
  throw error
}

try {
  // 1. First failure → DEGRADED, writes still attempted.
  try { save() } catch (_) {}
  health = getDbPersistenceHealth()
  assert(health.state === PERSISTENCE_STATES.DEGRADED && health.consecutiveSaveFailures === 1,
    `first save failure degrades (got ${health.state}/${health.consecutiveSaveFailures})`)

  // 2. A mutation below the threshold is attempted and fails with the raw
  //    disk error — NOT a persistence block.
  let rawError = null
  try { await run('INSERT INTO settings (user_id) VALUES (?)', ['ph-attempted']) } catch (e) { rawError = e }
  assert(rawError && rawError.name !== 'PersistenceBlockedError' && rawError.code === 'EACCES',
    `below threshold a write is attempted and fails with the disk error (got: ${rawError?.name}/${rawError?.code})`)
  health = getDbPersistenceHealth()
  assert(health.consecutiveSaveFailures === 2, `failed write counts toward the threshold (got ${health.consecutiveSaveFailures})`)

  // 3. Reach the threshold → WRITE_BLOCKED.
  try { save() } catch (_) {}
  health = getDbPersistenceHealth()
  assert(health.state === PERSISTENCE_STATES.WRITE_BLOCKED && health.consecutiveSaveFailures === 3,
    `threshold reached → WRITE_BLOCKED (got ${health.state}/${health.consecutiveSaveFailures})`)

  // 4. Reads stay available while blocked.
  const probe = await queryOne('SELECT 1 AS ok')
  assert(probe?.ok === 1, 'reads are never blocked by persistence policy')

  // 5. Mutations are rejected with PersistenceBlockedError (503 semantics).
  let blockedError = null
  try { await run('INSERT INTO settings (user_id) VALUES (?)', ['ph-blocked']) } catch (e) { blockedError = e }
  assert(blockedError instanceof PersistenceBlockedError,
    `blocked mutation throws PersistenceBlockedError (got: ${blockedError?.name}/${blockedError?.code})`)
  assert(blockedError?.code === 'DB_PERSISTENCE_BLOCKED' && blockedError?.statusCode === 503,
    'blocked mutation carries DB_PERSISTENCE_BLOCKED with 503')
} finally {
  fs.writeFileSync = originalWriteFileSync
}

// 6. Disk recovers → the next mutation probes save(), returns to HEALTHY and proceeds.
const recovered = await run('INSERT INTO settings (user_id) VALUES (?)', ['ph-recovered'])
health = getDbPersistenceHealth()
assert(recovered === true && health.state === PERSISTENCE_STATES.HEALTHY,
  `recovery probe restores HEALTHY (got ${health.state})`)
assert(health.consecutiveSaveFailures === 0 && health.lastSuccessfulSaveAt !== null,
  'recovery resets the failure counter and records the last successful save')
const row = await queryOne('SELECT user_id FROM settings WHERE user_id = ?', ['ph-recovered'])
assert(row?.user_id === 'ph-recovered', 'write proceeds after recovery')

// 7. Source fences: blocked writes surface as 503 at routes and as a
//    transient park inside the pipeline.
const readSrc = (...parts) => fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8')
const projectsRoute = readSrc('routes', 'v1', 'projects.js')
assert(projectsRoute.includes("DB_PERSISTENCE_BLOCKED"), 'project routes map persistence blocks to 503')
const dubDataRoute = readSrc('routes', 'v1', 'dubData.js')
assert(dubDataRoute.includes('DB_PERSISTENCE_BLOCKED'), 'transcript routes map persistence blocks to 503')
const runnerSrc = readSrc('pipeline', 'runner.js')
assert(runnerSrc.includes("err?.code === 'DB_PERSISTENCE_BLOCKED'"), 'pipeline treats persistence blocks as transient')
assert(runnerSrc.includes('Không thể đánh dấu failed'), 'pipeline survives a blocked failure write')

await run('DELETE FROM settings WHERE user_id IN (?, ?, ?)', ['ph-attempted', 'ph-blocked', 'ph-recovered']).catch(() => {})
fs.rmSync(tmpRoot, { recursive: true, force: true })
if (failures > 0) process.exit(1)
console.log('ALL PASS')
