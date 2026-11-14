import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '..', '.env') })

// Ensure we test PostgreSQL
delete process.env.DB_PATH
delete process.env.FORCE_SQLITE

const { isPostgresMode, getPool, closePool, getDbPersistenceHealth, PERSISTENCE_STATES } = await import('../src/db.js')
const {
  query,
  queryOne,
  run,
  runAffected,
  insert,
  updateById,
  findById,
  withTransaction,
  convertSqlForPostgres,
  sanitizeVal,
  sanitizeParams,
} = await import('../src/db/query.js')
const { insertMany } = await import('../src/pipeline/context.js')
const { initSchema } = await import('../src/db/schema.js')

await initSchema()

console.log('=== PostgreSQL Database Access Layer Verification Suite ===\n')

// 1. Mode & Pool verification
assert.equal(isPostgresMode(), true, 'isPostgresMode() should be true when DATABASE_URL is set')
const pool = getPool()
assert.ok(pool, 'getPool() should return a pg.Pool instance')

// Health stats check
const health = getDbPersistenceHealth()
assert.equal(health.state, PERSISTENCE_STATES.HEALTHY, 'Persistence health should be HEALTHY')
assert.equal(health.engine, 'postgresql', 'Persistence engine should be postgresql')
console.log('✓ Mode & Health stats check PASSED')

// 2. SQL Converter verification
const testSql1 = 'SELECT * FROM users WHERE email = ? AND role = ?'
assert.equal(convertSqlForPostgres(testSql1), 'SELECT * FROM users WHERE email = $1 AND role = $2')

const testSql2 = "SELECT * FROM projects WHERE title = 'What?' AND user_id = ?"
assert.equal(convertSqlForPostgres(testSql2), "SELECT * FROM projects WHERE title = 'What?' AND user_id = $1")

const testSql3 = 'INSERT OR IGNORE INTO settings (user_id) VALUES (?)'
assert.equal(convertSqlForPostgres(testSql3), 'INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING')

const testSql4 = 'SELECT * FROM outputs WHERE project_id = ? ORDER BY created_date DESC, rowid DESC LIMIT 1'
assert.equal(convertSqlForPostgres(testSql4), 'SELECT * FROM outputs WHERE project_id = $1 ORDER BY created_date DESC, ctid DESC LIMIT 1')

const testSql5 = 'INSERT OR REPLACE INTO provider_cache (id, provider, type, input_hash, result, expires_date) VALUES (?, ?, ?, ?, ?, ?)'
const converted5 = convertSqlForPostgres(testSql5)
assert.ok(converted5.includes('ON CONFLICT (provider, type, input_hash) DO UPDATE'), 'Should convert provider_cache UPSERT')
console.log('✓ SQL Dialect Converter PASSED')

// 3. Sanitizer verification
assert.equal(sanitizeVal(undefined), null)
assert.equal(sanitizeVal('text'), 'text')
assert.equal(sanitizeVal(123), 123)
assert.equal(sanitizeVal({ key: 'val' }), '{"key":"val"}')
assert.deepEqual(sanitizeParams([1, { a: 2 }, undefined]), [1, '{"a":2}', null])
console.log('✓ Parameter Sanitizer PASSED')

// 4. Basic Query & QueryOne
const allUsers = await query('SELECT * FROM users ORDER BY created_date ASC LIMIT 5')
assert.ok(Array.isArray(allUsers), 'query() should return array')
assert.ok(allUsers.length > 0, 'should return rows')

const testUserEmail = `pg_lead_test_${Date.now()}@example.com`
const testUserId = `user-pg-lead-${Date.now()}`

// 5. Insert with RETURNING *
const insertedUser = await insert('users', {
  id: testUserId,
  email: testUserEmail,
  password: 'test-password-hash',
  role: 'user',
  name: 'PG Test Lead',
})
assert.ok(insertedUser, 'insert() should return inserted row')
assert.equal(insertedUser.id, testUserId)
assert.equal(insertedUser.email, testUserEmail)
assert.equal(insertedUser.name, 'PG Test Lead')
console.log('✓ insert() with RETURNING * PASSED')

// 6. findById & queryOne
const foundUser = await findById('users', testUserId)
assert.ok(foundUser, 'findById should find inserted row')
assert.equal(foundUser.email, testUserEmail)

const userByEmail = await queryOne('SELECT * FROM users WHERE email = ?', [testUserEmail])
assert.ok(userByEmail, 'queryOne should find user by email')
assert.equal(userByEmail.id, testUserId)
console.log('✓ findById() & queryOne() PASSED')

// 7. updateById with RETURNING *
const updatedUser = await updateById('users', testUserId, {
  name: 'PG Test Lead Updated',
})
assert.ok(updatedUser, 'updateById should return updated row')
assert.equal(updatedUser.name, 'PG Test Lead Updated')
console.log('✓ updateById() with RETURNING * PASSED')

// 8. run & runAffected
const affected = await runAffected('UPDATE users SET name = ? WHERE id = ?', ['PG Affected Run', testUserId])
assert.equal(affected, 1, 'runAffected should return 1')

const runRes = await run('UPDATE users SET name = ? WHERE id = ?', ['PG Run Final', testUserId])
assert.equal(runRes, true, 'run() should return true')
console.log('✓ run() & runAffected() PASSED')

// 9. withTransaction - Commit flow
const txProjectId = `proj-pg-tx-${Date.now()}`
const txRes = await withTransaction(async (tx) => {
  const p = await tx.insert('projects', {
    id: txProjectId,
    user_id: testUserId,
    title: 'Tx Test Project',
    mode: 'SUMMARY',
    status: 'queued',
  })
  assert.equal(p.id, txProjectId)

  const updatedP = await tx.updateById('projects', txProjectId, {
    title: 'Tx Test Project Updated',
  })
  assert.equal(updatedP.title, 'Tx Test Project Updated')

  const qRow = await tx.queryOne('SELECT * FROM projects WHERE id = ?', [txProjectId])
  assert.equal(qRow.title, 'Tx Test Project Updated')

  return p
})
assert.ok(txRes, 'Transaction should commit and return result')
const committedProject = await findById('projects', txProjectId)
assert.ok(committedProject, 'Project should exist after commit')
assert.equal(committedProject.title, 'Tx Test Project Updated')
console.log('✓ withTransaction() Commit flow PASSED')

// 10. withTransaction - Rollback flow
const rollbackProjId = `proj-pg-rollback-${Date.now()}`
let caughtError = false
try {
  await withTransaction(async (tx) => {
    await tx.insert('projects', {
      id: rollbackProjId,
      user_id: testUserId,
      title: 'Should Rollback',
      mode: 'SUMMARY',
      status: 'queued',
    })
    throw new Error('Simulated Transaction Failure')
  })
} catch (err) {
  caughtError = true
  assert.equal(err.message, 'Simulated Transaction Failure')
}
assert.equal(caughtError, true, 'Error should be rethrown')
const rolledBackProj = await findById('projects', rollbackProjId)
assert.equal(rolledBackProj, null, 'Rolled back project must NOT exist in DB')
console.log('✓ withTransaction() Rollback flow PASSED')

// 11. insertMany
const track1Id = `track-pg-1-${Date.now()}`
const track2Id = `track-pg-2-${Date.now()}`
await insertMany('timeline_tracks', [
  { id: track1Id, project_id: txProjectId, name: 'Video Track 1', track_type: 'video', order_index: 0 },
  { id: track2Id, project_id: txProjectId, name: 'Audio Track 1', track_type: 'audio', order_index: 1 },
])
const tracks = await query('SELECT * FROM timeline_tracks WHERE project_id = ? ORDER BY order_index ASC', [txProjectId])
assert.equal(tracks.length, 2, 'insertMany should insert 2 rows')
assert.equal(tracks[0].id, track1Id)
assert.equal(tracks[1].id, track2Id)
console.log('✓ insertMany() bulk insert PASSED')

// 12. Cleanup test artifacts
await run('DELETE FROM timeline_tracks WHERE project_id = ?', [txProjectId])
await run('DELETE FROM projects WHERE id = ?', [txProjectId])
await run('DELETE FROM users WHERE id = ?', [testUserId])

const cleanedUser = await findById('users', testUserId)
assert.equal(cleanedUser, null, 'Test user should be deleted')
console.log('✓ Cleanup PASSED')

await closePool()
console.log('\nALL POSTGRESQL ACCESS TESTS PASSED 100%!')
