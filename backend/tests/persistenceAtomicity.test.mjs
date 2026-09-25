// Persistence atomicity (persistence boundary, Issues A-C).
// A mutation is committed ONLY when both the sql.js memory write and save()
// succeeded. Therefore:
// - a save() failure must leave NO row in the in-memory DB (rolled back)
// - a retry after recovery must produce exactly ONE row (no duplicates)
// - withTransaction: save() failure rolls the whole transaction back
// - the WRITE_BLOCKED recovery probe must never persist a rejected mutation
// Disk assertions read DB_PATH with a FRESH sql.js handle, so they prove what
// is persisted — not what the API-visible in-memory DB happens to contain.
// Run: node backend/tests/persistenceAtomicity.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-persist-atomic-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.DB_MAX_SAVE_FAILURES = '5'

const { initSchema } = await import('../src/db/schema.js')
const { getDbPersistenceHealth, PERSISTENCE_STATES } = await import('../src/db.js')
const {
  run, runAffected, insert, updateById, queryOne, withTransaction, PersistenceBlockedError,
} = await import('../src/db/query.js')
const initSqlJs = (await import('sql.js')).default

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }
const scenario = async (name, fn) => {
  try {
    await fn()
  } catch (error) {
    failures += 1
    console.error(`FAIL: ${name} threw unexpectedly — ${error?.stack || error}`)
  }
}

const SQL = await initSqlJs()

// What is REALLY on disk (independent handle over the persisted bytes).
function diskCount(table, column, value) {
  const disk = new SQL.Database(fs.readFileSync(process.env.DB_PATH))
  try {
    const result = disk.exec(`SELECT COUNT(*) FROM ${table} WHERE ${column} = ?`, [value])
    return Number(result?.[0]?.values?.[0]?.[0] ?? -1)
  } finally {
    disk.close()
  }
}

function diskValue(table, column, value, field) {
  const disk = new SQL.Database(fs.readFileSync(process.env.DB_PATH))
  try {
    const result = disk.exec(`SELECT ${field} FROM ${table} WHERE ${column} = ?`, [value])
    return result?.[0]?.values?.[0]?.[0] ?? null
  } finally {
    disk.close()
  }
}

const memCount = async (value) =>
  Number((await queryOne('SELECT COUNT(*) AS c FROM settings WHERE user_id = ?', [value]))?.c ?? -1)

const originalWriteFileSync = fs.writeFileSync
const failDisk = () => {
  fs.writeFileSync = () => {
    const error = new Error('EACCES: simulated save failure')
    error.code = 'EACCES'
    throw error
  }
}
const restoreDisk = () => { fs.writeFileSync = originalWriteFileSync }

// Runs fn with a broken disk, returns the rejection (or null when it wrongly succeeded).
async function rejectedWhileDiskBroken(fn) {
  failDisk()
  let error = null
  try { await fn() } catch (e) { error = e } finally { restoreDisk() }
  return error
}

// ── 1. insert(): failed save must not leave a phantom row ──
await scenario('insert', async () => {
  const error = await rejectedWhileDiskBroken(() => insert('settings', { user_id: 'pa-insert' }))
  assert(error && error.code === 'EACCES' && error.name !== 'PersistenceBlockedError',
    `insert save failure rejects with the disk error (got ${error?.name}/${error?.code})`)
  assert(await memCount('pa-insert') === 0, 'failed insert leaves NO row in the in-memory DB')
  assert(diskCount('settings', 'user_id', 'pa-insert') === 0, 'failed insert is NOT on disk')

  const row = await insert('settings', { user_id: 'pa-insert' })
  assert(row?.user_id === 'pa-insert', 'retry after recovery succeeds')
  assert(await memCount('pa-insert') === 1, 'retry leaves exactly one row in memory')
  assert(diskCount('settings', 'user_id', 'pa-insert') === 1, 'retry persists exactly one row (no duplicate)')
})

// ── 2. run(): failed UPDATE leaves memory AND disk at the old value ──
await scenario('run', async () => {
  await run('INSERT INTO settings (user_id, default_language) VALUES (?, ?)', ['pa-update', 'vi'])
  const error = await rejectedWhileDiskBroken(() =>
    run('UPDATE settings SET default_language = ? WHERE user_id = ?', ['fr', 'pa-update']))
  assert(error?.code === 'EACCES', `run save failure rejects with the disk error (got ${error?.code})`)
  const mem = await queryOne('SELECT default_language FROM settings WHERE user_id = ?', ['pa-update'])
  assert(mem?.default_language === 'vi', `failed UPDATE leaves memory unchanged (got ${mem?.default_language})`)
  assert(diskValue('settings', 'user_id', 'pa-update', 'default_language') === 'vi',
    'failed UPDATE is not persisted later')

  await run('UPDATE settings SET default_language = ? WHERE user_id = ?', ['fr', 'pa-update'])
  const after = await queryOne('SELECT default_language FROM settings WHERE user_id = ?', ['pa-update'])
  assert(after?.default_language === 'fr', 'retry applies the update in memory')
  assert(diskValue('settings', 'user_id', 'pa-update', 'default_language') === 'fr', 'retry persists the update')
})

// ── 3. runAffected(): same boundary ──
await scenario('runAffected', async () => {
  const error = await rejectedWhileDiskBroken(() =>
    runAffected('UPDATE settings SET default_style = ? WHERE user_id = ?', ['noir', 'pa-update']))
  assert(error?.code === 'EACCES', `runAffected save failure rejects with the disk error (got ${error?.code})`)
  const mem = await queryOne('SELECT default_style FROM settings WHERE user_id = ?', ['pa-update'])
  assert(mem?.default_style === 'cinematic', `failed runAffected leaves memory unchanged (got ${mem?.default_style})`)
  assert(diskValue('settings', 'user_id', 'pa-update', 'default_style') === 'cinematic',
    'failed runAffected is not persisted later')

  const affected = await runAffected('UPDATE settings SET default_style = ? WHERE user_id = ?', ['noir', 'pa-update'])
  assert(affected === 1, `retry reports the affected row count (got ${affected})`)
  assert(diskValue('settings', 'user_id', 'pa-update', 'default_style') === 'noir', 'retry persists the change')
})

// ── 4. updateById(): same boundary ──
await scenario('updateById', async () => {
  await run('INSERT INTO projects (id, user_id, mode, title) VALUES (?, ?, ?, ?)',
    ['pa-proj', 'pa-user', 'SUMMARY', 'before'])
  const error = await rejectedWhileDiskBroken(() =>
    updateById('projects', 'pa-proj', { title: 'after' }))
  assert(error?.code === 'EACCES', `updateById save failure rejects with the disk error (got ${error?.code})`)
  const mem = await queryOne('SELECT title FROM projects WHERE id = ?', ['pa-proj'])
  assert(mem?.title === 'before', `failed updateById leaves memory unchanged (got ${mem?.title})`)
  assert(diskValue('projects', 'id', 'pa-proj', 'title') === 'before',
    'failed updateById is not persisted later')

  await updateById('projects', 'pa-proj', { title: 'after' })
  const after = await queryOne('SELECT title FROM projects WHERE id = ?', ['pa-proj'])
  assert(after?.title === 'after', 'retry applies updateById')
  assert(diskValue('projects', 'id', 'pa-proj', 'title') === 'after', 'retry persists updateById')
  await run('DELETE FROM projects WHERE id = ?', ['pa-proj'])
})

// ── 5. withTransaction(): save failure rolls the whole transaction back ──
await scenario('withTransaction', async () => {
  const error = await rejectedWhileDiskBroken(() => withTransaction(async (tx) => {
    await tx.insert('settings', { user_id: 'pa-tx-1' })
    await tx.insert('settings', { user_id: 'pa-tx-2' })
  }, { op: 'test.atomicity' }))
  assert(error && error.code === 'EACCES' && error.name !== 'PersistenceBlockedError',
    `transaction save failure rejects with the disk error (got ${error?.name}/${error?.code})`)
  assert(await memCount('pa-tx-1') === 0 && await memCount('pa-tx-2') === 0,
    'save failure rolls the whole transaction back in memory')
  assert(diskCount('settings', 'user_id', 'pa-tx-1') === 0 && diskCount('settings', 'user_id', 'pa-tx-2') === 0,
    'save failure leaves the transaction off disk')

  await withTransaction(async (tx) => {
    await tx.insert('settings', { user_id: 'pa-tx-1' })
    await tx.insert('settings', { user_id: 'pa-tx-2' })
  }, { op: 'test.atomicity' })
  assert(await memCount('pa-tx-1') === 1 && await memCount('pa-tx-2') === 1, 'retry commits both rows in memory')
  assert(diskCount('settings', 'user_id', 'pa-tx-1') === 1 && diskCount('settings', 'user_id', 'pa-tx-2') === 1,
    'retry persists both rows exactly once')

  // A failure INSIDE the transaction (before save) still rolls back too.
  let innerError = null
  try {
    await withTransaction(async (tx) => {
      await tx.insert('settings', { user_id: 'pa-tx-3' })
      throw new Error('mid-transaction failure')
    }, { op: 'test.atomicity' })
  } catch (e) { innerError = e }
  assert(innerError?.message === 'mid-transaction failure', 'mid-transaction error propagates')
  assert(await memCount('pa-tx-3') === 0 && diskCount('settings', 'user_id', 'pa-tx-3') === 0,
    'mid-transaction failure leaves no row in memory or on disk')
})

// ── 6. WRITE_BLOCKED + recovery probe must not resurrect rejected mutations ──
await scenario('probeSafety', async () => {
  // Settle any earlier failure accounting: a successful save must reset the
  // counter so the threshold below is measured from zero.
  await run('INSERT INTO settings (user_id) VALUES (?)', ['pa-settle'])
  let health = getDbPersistenceHealth()
  assert(health.state === PERSISTENCE_STATES.HEALTHY && health.consecutiveSaveFailures === 0
    && health.maxSaveFailures === 5,
    `state machine starts HEALTHY with the configured threshold (got ${health.state}/${health.consecutiveSaveFailures}/${health.maxSaveFailures})`)

  failDisk()
  const rejected = ['pa-blk-1', 'pa-blk-2', 'pa-blk-3', 'pa-blk-4', 'pa-blk-5']
  const errors = []
  for (const id of rejected) {
    try {
      await run('INSERT INTO settings (user_id) VALUES (?)', [id])
      errors.push(null)
    } catch (e) { errors.push(e) }
  }
  health = getDbPersistenceHealth()
  assert(health.state === PERSISTENCE_STATES.WRITE_BLOCKED && health.consecutiveSaveFailures === 5,
    `5 consecutive save failures reach WRITE_BLOCKED (got ${health.state}/${health.consecutiveSaveFailures})`)
  assert(errors.every((e) => e && e.code === 'EACCES' && e.name !== 'PersistenceBlockedError'),
    'every write at/below the threshold fails with the disk error')

  // Still blocked while the disk is broken → 503 semantics, no mutation.
  let blockedError = null
  try { await run('INSERT INTO settings (user_id) VALUES (?)', ['pa-blk-probe']) } catch (e) { blockedError = e }
  assert(blockedError instanceof PersistenceBlockedError && blockedError.code === 'DB_PERSISTENCE_BLOCKED',
    `blocked write rejects with PersistenceBlockedError (got ${blockedError?.name}/${blockedError?.code})`)
  restoreDisk()

  for (const id of [...rejected, 'pa-blk-probe']) {
    assert(await memCount(id) === 0, `${id}: rejected write left no in-memory row`)
    assert(diskCount('settings', 'user_id', id) === 0, `${id}: rejected write is not on disk`)
  }

  // Disk recovers → the probe save() runs BEFORE the mutation. It must only
  // re-persist confirmed state, never a mutation a caller was told failed.
  const recovered = await run('INSERT INTO settings (user_id) VALUES (?)', ['pa-recovered'])
  health = getDbPersistenceHealth()
  assert(recovered === true && health.state === PERSISTENCE_STATES.HEALTHY,
    `recovery probe restores HEALTHY and lets the write proceed (got ${health.state})`)
  for (const id of rejected) {
    assert(await memCount(id) === 0 && diskCount('settings', 'user_id', id) === 0,
      `${id}: recovery probe did not persist the rejected mutation`)
  }
  assert(await memCount('pa-recovered') === 1 && diskCount('settings', 'user_id', 'pa-recovered') === 1,
    'the post-recovery write is the only one that persists')

  await run("DELETE FROM settings WHERE user_id LIKE 'pa-%'")
})

// ── 7. Source fences: the persistence boundary stays wired ──
{
  const readSrc = (...parts) => fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8')
  const querySrc = readSrc('db', 'query.js')
  assert(querySrc.includes('persistOrRollback'), 'query.js persists through the atomic boundary')
  assert((querySrc.match(/persistOrRollback\(/g) || []).length >= 3, 'run, runAffected and transactions all use the boundary')
  const dbSrc = readSrc('db.js')
  assert(dbSrc.includes('captureMemorySnapshot') && dbSrc.includes('restoreMemorySnapshot'),
    'db.js exposes snapshot capture and rollback')
}

restoreDisk()
fs.rmSync(tmpRoot, { recursive: true, force: true })
if (failures > 0) process.exit(1)
console.log('ALL PASS')
