// Persistence atomicity & PostgreSQL ACID transaction boundary tests.
// Proves that:
// - withTransaction commits all mutations atomically
// - withTransaction failure rolls the entire transaction back (0 partial writes)
// - independent pool handles confirm committed state directly from PostgreSQL
// - insert(), updateById(), run(), runAffected(), runReturningOne() execute reliably
// Run: node backend/tests/persistenceAtomicity.test.mjs
import pg from 'pg'
const { Pool: PgPool } = pg

const { initSchema } = await import('../src/db/schema.js')
const { getPool, closePool, getDbPersistenceHealth, PERSISTENCE_STATES } = await import('../src/db.js')
const {
  run,
  runAffected,
  insert,
  updateById,
  queryOne,
  withTransaction,
  runReturningOne,
  PersistenceBlockedError,
} = await import('../src/db/query.js')

await initSchema()

let failures = 0
const assert = (c, m) => {
  if (c) console.log('PASS:', m)
  else {
    failures++
    console.error('FAIL:', m)
  }
}
const scenario = async (name, fn) => {
  try {
    await fn()
  } catch (error) {
    failures += 1
    console.error(`FAIL: ${name} threw unexpectedly — ${error?.stack || error}`)
  }
}

// Independent handle over PostgreSQL for verifiable proof of committed state
const verifyPool = new PgPool({
  connectionString: process.env.DATABASE_URL || 'postgresql://video_ai_user:VideoAI_Secure_Db_2026!@localhost:5433/video_ai_test',
})

async function directCount(table, column, value) {
  const res = await verifyPool.query(`SELECT COUNT(*)::int AS c FROM "${table}" WHERE "${column}" = $1`, [value])
  return Number(res.rows[0]?.c ?? -1)
}

async function directValue(table, column, value, field) {
  const res = await verifyPool.query(`SELECT "${field}" FROM "${table}" WHERE "${column}" = $1`, [value])
  return res.rows[0]?.[field] ?? null
}

const memCount = async (value) =>
  Number((await queryOne('SELECT COUNT(*)::int AS c FROM settings WHERE user_id = ?', [value]))?.c ?? -1)

// Ensure clean slate for test user ids
await run("DELETE FROM settings WHERE user_id LIKE 'pa-%'")
await run("DELETE FROM projects WHERE id LIKE 'pa-%'")
await run("DELETE FROM users WHERE id LIKE 'pa-%'")

// Seed prerequisite users for FK constraints
await run("INSERT INTO users (id, email, password) VALUES ('pa-user', 'pa-user@test.local', 'pw') ON CONFLICT DO NOTHING")
await run("INSERT INTO users (id, email, password) VALUES ('pa-insert', 'pa-insert@test.local', 'pw') ON CONFLICT DO NOTHING")
await run("INSERT INTO users (id, email, password) VALUES ('pa-update', 'pa-update@test.local', 'pw') ON CONFLICT DO NOTHING")
await run("INSERT INTO users (id, email, password) VALUES ('pa-tx-1', 'pa-tx-1@test.local', 'pw') ON CONFLICT DO NOTHING")
await run("INSERT INTO users (id, email, password) VALUES ('pa-tx-2', 'pa-tx-2@test.local', 'pw') ON CONFLICT DO NOTHING")
await run("INSERT INTO users (id, email, password) VALUES ('pa-tx-3', 'pa-tx-3@test.local', 'pw') ON CONFLICT DO NOTHING")
await run("INSERT INTO users (id, email, password) VALUES ('pa-settle', 'pa-settle@test.local', 'pw') ON CONFLICT DO NOTHING")
await run("INSERT INTO users (id, email, password) VALUES ('pa-recovered', 'pa-recovered@test.local', 'pw') ON CONFLICT DO NOTHING")
await run("INSERT INTO users (id, email, password) VALUES ('pa-ret', 'pa-ret@test.local', 'pw') ON CONFLICT DO NOTHING")

// ── 1. insert(): succeeds and persists to PostgreSQL ──
await scenario('insert', async () => {
  const row = await insert('settings', { user_id: 'pa-insert', default_language: 'vi' })
  assert(row?.user_id === 'pa-insert', 'insert succeeds and returns inserted row')
  assert(await memCount('pa-insert') === 1, 'inserted row visible via queryOne')
  assert(await directCount('settings', 'user_id', 'pa-insert') === 1, 'inserted row committed in PostgreSQL')
})

// ── 2. run(): UPDATE changes persisted value ──
await scenario('run', async () => {
  await run('INSERT INTO settings (user_id, default_language) VALUES (?, ?) ON CONFLICT DO NOTHING', ['pa-update', 'vi'])
  await run('UPDATE settings SET default_language = ? WHERE user_id = ?', ['fr', 'pa-update'])
  const val = await queryOne('SELECT default_language FROM settings WHERE user_id = ?', ['pa-update'])
  assert(val?.default_language === 'fr', 'UPDATE applies to row')
  assert(await directValue('settings', 'user_id', 'pa-update', 'default_language') === 'fr', 'UPDATE committed in PostgreSQL')
})

// ── 3. runAffected(): reports rowCount ──
await scenario('runAffected', async () => {
  const affected = await runAffected('UPDATE settings SET default_style = ? WHERE user_id = ?', ['noir', 'pa-update'])
  assert(affected === 1, `runAffected reports correct affected row count (got ${affected})`)
  assert(await directValue('settings', 'user_id', 'pa-update', 'default_style') === 'noir', 'runAffected update persisted')
})

// ── 4. updateById(): updates and returns row ──
await scenario('updateById', async () => {
  await run('INSERT INTO projects (id, user_id, mode, title) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
    ['pa-proj', 'pa-user', 'SUMMARY', 'before'])
  const updated = await updateById('projects', 'pa-proj', { title: 'after' })
  assert(updated?.title === 'after', 'updateById returns updated row')
  assert(await directValue('projects', 'id', 'pa-proj', 'title') === 'after', 'updateById committed in PostgreSQL')
  await run('DELETE FROM projects WHERE id = ?', ['pa-proj'])
})

// ── 5. withTransaction(): atomicity and rollback on error ──
await scenario('withTransaction', async () => {
  // A. Successful transaction: both rows commit
  await withTransaction(async (tx) => {
    await tx.insert('settings', { user_id: 'pa-tx-1' })
    await tx.insert('settings', { user_id: 'pa-tx-2' })
  })
  assert(await directCount('settings', 'user_id', 'pa-tx-1') === 1, 'transaction committed first row')
  assert(await directCount('settings', 'user_id', 'pa-tx-2') === 1, 'transaction committed second row')

  // B. Failing transaction: mid-transaction error rolls back completely
  let innerError = null
  try {
    await withTransaction(async (tx) => {
      await tx.insert('settings', { user_id: 'pa-tx-3' })
      throw new Error('mid-transaction failure')
    })
  } catch (e) {
    innerError = e
  }
  assert(innerError?.message === 'mid-transaction failure', 'mid-transaction error propagates')
  assert(await directCount('settings', 'user_id', 'pa-tx-3') === 0,
    'failed transaction rolls back completely: 0 rows in PostgreSQL')
})

// ── 6. Persistence health stats ──
await scenario('healthStats', async () => {
  const health = getDbPersistenceHealth()
  assert(health.engine === 'postgresql', `health reports engine postgresql (got ${health.engine})`)
  assert(health.state === PERSISTENCE_STATES.HEALTHY, `state is HEALTHY (got ${health.state})`)
})

// ── 7. runReturningOne: mutation + return as atomic operation ──
await scenario('runReturningOne', async () => {
  const row = await runReturningOne(
    'INSERT INTO settings (user_id, default_language) VALUES (?, ?)',
    ['pa-ret', 'de'],
    'SELECT * FROM settings WHERE user_id = ?', ['pa-ret']
  )
  assert(row?.default_language === 'de', `runReturningOne returns inserted row (got ${row?.default_language})`)
  assert(await directValue('settings', 'user_id', 'pa-ret', 'default_language') === 'de', 'returned row verified in PostgreSQL')

  const updated = await runReturningOne(
    'UPDATE settings SET default_language = ? WHERE user_id = ?',
    ['ja', 'pa-ret'],
    'SELECT * FROM settings WHERE user_id = ?', ['pa-ret']
  )
  assert(updated?.default_language === 'ja', 'runReturningOne returns updated row')
  assert(await directValue('settings', 'user_id', 'pa-ret', 'default_language') === 'ja', 'updated row verified in PostgreSQL')
})

// Cleanup
await run("DELETE FROM settings WHERE user_id LIKE 'pa-%'")
await run("DELETE FROM projects WHERE id LIKE 'pa-%'")
await run("DELETE FROM users WHERE id LIKE 'pa-%'")

await verifyPool.end()
await closePool()

if (failures > 0) process.exit(1)
console.log('ALL PASS')
process.exit(0)
