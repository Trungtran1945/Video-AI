import assert from 'node:assert'
import express from 'express'
import { once } from 'node:events'
import { v4 as uuidv4 } from 'uuid'
import {
  query,
  queryOne,
  insert,
  updateById,
  findById,
  withTransaction,
  ALLOWED_TABLES,
  assertValidTable,
  assertValidColumnName,
  buildSafeOrderBy,
  validatePagination,
} from '../src/db/query.js'
import { generateAccessToken } from '../src/middleware/auth.js'
import projectsRouter from '../src/routes/v1/projects.js'

let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log(`PASS: ${name}`)
  } catch (err) {
    failures++
    console.error(`FAIL: ${name} ->`, err.message)
  }
}

async function asyncTest(name, fn) {
  try {
    await fn()
    console.log(`PASS: ${name}`)
  } catch (err) {
    failures++
    console.error(`FAIL: ${name} ->`, err)
  }
}

async function run() {
  console.log('\n--- SECTION 1: Dynamic Table Allowlisting & Injection Prevention ---')

  test('assertValidTable permits valid application tables', () => {
    assert.strictEqual(assertValidTable('users'), 'users')
    assert.strictEqual(assertValidTable('projects'), 'projects')
    assert.strictEqual(assertValidTable('settings'), 'settings')
    assert.strictEqual(assertValidTable('cloudinary_assets'), 'cloudinary_assets')
    assert.strictEqual(assertValidTable('media_migration_manifest'), 'media_migration_manifest')
    assert.strictEqual(assertValidTable('  Projects  '), 'projects')
    assert.strictEqual(ALLOWED_TABLES.size, 34)
  })

  test('assertValidTable rejects unauthorized or non-existent tables', () => {
    assert.throws(() => assertValidTable('non_existent_table'), /Invalid or unauthorized table name/)
    assert.throws(() => assertValidTable('pg_shadow'), /Invalid or unauthorized table name/)
    assert.throws(() => assertValidTable('information_schema.tables'), /Invalid or unauthorized table name/)
  })

  await asyncTest('CRUD functions reject SQL injection payloads in table name', async () => {
    const tableInjections = [
      'projects; DROP TABLE users; --',
      'users" WHERE 1=1; --',
      "projects' UNION SELECT * FROM users --",
      'projects/*',
      'users; VACUUM;',
    ]

    for (const payload of tableInjections) {
      assert.throws(() => assertValidTable(payload), /Invalid or unauthorized table name/)

      await assert.rejects(
        async () => insert(payload, { title: 'exploit' }),
        /Invalid or unauthorized table name/
      )

      await assert.rejects(
        async () => updateById(payload, 'test-id', { title: 'exploit' }),
        /Invalid or unauthorized table name/
      )

      await assert.rejects(
        async () => findById(payload, 'test-id'),
        /Invalid or unauthorized table name/
      )
    }
  })

  test('assertValidTable rejects non-string types', () => {
    assert.throws(() => assertValidTable(null), /Invalid table name type/)
    assert.throws(() => assertValidTable(123), /Invalid table name type/)
    assert.throws(() => assertValidTable({}), /Invalid table name type/)
  })

  console.log('\n--- SECTION 2: Dynamic Column Name Validation & Injection Prevention ---')

  test('assertValidColumnName permits valid column identifiers', () => {
    assert.strictEqual(assertValidColumnName('title'), 'title')
    assert.strictEqual(assertValidColumnName('user_id'), 'user_id')
    assert.strictEqual(assertValidColumnName('created_date'), 'created_date')
    assert.strictEqual(assertValidColumnName('step_2'), 'step_2')
  })

  await asyncTest('assertValidColumnName and CRUD helpers reject unsafe column names', async () => {
    const columnInjections = [
      'title" = 1; --',
      'title; DROP TABLE users;',
      "title' OR '1'='1",
      'user_id--',
      'title/*',
      'title = 1',
      'column name with spaces',
      'col$name',
      'col`name`',
    ]

    for (const payload of columnInjections) {
      assert.throws(() => assertValidColumnName(payload), /Invalid or unsafe column name/)

      await assert.rejects(
        async () => insert('projects', { [payload]: 'bad_value' }),
        /Invalid or unsafe column name/
      )

      await assert.rejects(
        async () => updateById('projects', 'test-id', { [payload]: 'bad_value' }),
        /Invalid or unsafe column name/
      )
    }
  })

  console.log('\n--- SECTION 3: Safe ORDER BY Construction & Injection Immunity ---')

  test('buildSafeOrderBy validates whitelist and directions properly', () => {
    const allowed = ['title', 'created_date', 'status']

    // Valid inputs
    assert.strictEqual(buildSafeOrderBy('title', 'ASC', allowed), '"title" ASC')
    assert.strictEqual(buildSafeOrderBy('created_date', 'DESC', allowed), '"created_date" DESC')
    assert.strictEqual(buildSafeOrderBy('status', 'asc', allowed), '"status" ASC')

    // Injected sort column falls back safely to default sort
    assert.strictEqual(
      buildSafeOrderBy('title; DROP TABLE projects; --', 'ASC', allowed, 'created_date DESC'),
      'created_date DESC'
    )
    assert.strictEqual(
      buildSafeOrderBy('1 UNION SELECT password FROM users', 'ASC', allowed, 'created_date DESC'),
      'created_date DESC'
    )
    assert.strictEqual(
      buildSafeOrderBy('(CASE WHEN (1=1) THEN title ELSE created_date END)', 'ASC', allowed, 'created_date DESC'),
      'created_date DESC'
    )

    // Injected sort direction normalizes safely to DESC or ASC
    assert.strictEqual(
      buildSafeOrderBy('title', 'ASC; DROP TABLE users; --', allowed),
      '"title" DESC'
    )
    assert.strictEqual(
      buildSafeOrderBy('title', "' OR 1=1 --", allowed),
      '"title" DESC'
    )

    // Missing or null inputs
    assert.strictEqual(buildSafeOrderBy(null, null, allowed, 'created_date DESC'), 'created_date DESC')
    assert.strictEqual(buildSafeOrderBy(undefined, 'ASC', allowed, 'created_date DESC'), 'created_date DESC')
  })

  console.log('\n--- SECTION 4: Safe Pagination Clamping & Boundary Enforcement ---')

  test('validatePagination constrains limit and offset correctly', () => {
    // Normal pagination
    const p1 = validatePagination(25, 50)
    assert.strictEqual(p1.limit, 25)
    assert.strictEqual(p1.offset, 50)

    // Excessive limit clamped to maxLimit
    const p2 = validatePagination(1000000, 0, 100)
    assert.strictEqual(p2.limit, 100)
    assert.strictEqual(p2.offset, 0)

    // Negative / invalid inputs sanitized to defaults
    const p3 = validatePagination(-10, -50)
    assert.strictEqual(p3.limit, 20)
    assert.strictEqual(p3.offset, 0)

    const p4 = validatePagination('invalid', 'bad_offset')
    assert.strictEqual(p4.limit, 20)
    assert.strictEqual(p4.offset, 0)
  })

  console.log('\n--- SECTION 5: Query Parameterization & SQLi Immunity in Queries ---')

  await asyncTest('query and queryOne treat injection payloads as literal strings', async () => {
    // Classic SQL injection attempt in query parameter
    const sqliEmail = "' OR '1'='1"
    const rows = await query('SELECT * FROM users WHERE email = ?', [sqliEmail])
    assert.strictEqual(rows.length, 0, 'SQL injection in email parameter must return 0 rows')

    // SQL injection attempt in queryOne
    const sqliId = "non_existent' UNION SELECT id, 'admin', 'hacked@test.local', 'user' FROM users --"
    const row = await queryOne('SELECT * FROM projects WHERE id = ?', [sqliId])
    assert.strictEqual(row, null, 'SQL injection in ID parameter must return null')
  })

  await asyncTest('Legitimate CRUD cycle with parameterization and transaction validation', async () => {
    const testUserId = uuidv4()
    const testProjectId = uuidv4()

    // 1. Insert user
    const user = await insert('users', {
      id: testUserId,
      email: `sqli_test_${Date.now()}@example.com`,
      password: '$2b$10$abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqr',
      role: 'user',
    })
    assert.ok(user?.id)

    // 2. Insert project
    const proj = await insert('projects', {
      id: testProjectId,
      user_id: testUserId,
      mode: 'TRANSLATE_DUB',
      title: 'Valid Parameterized Project',
      status: 'pending',
    })
    assert.strictEqual(proj.title, 'Valid Parameterized Project')

    // 3. Read by ID
    const fetched = await findById('projects', testProjectId)
    assert.strictEqual(fetched.id, testProjectId)

    // 4. Update by ID
    const updated = await updateById('projects', testProjectId, {
      title: 'Updated Parameterized Project',
    })
    assert.strictEqual(updated.title, 'Updated Parameterized Project')

    // 5. Transaction-level validation
    await withTransaction(async (tx) => {
      const txProj = await tx.updateById('projects', testProjectId, {
        title: 'Tx Updated Title',
      })
      assert.strictEqual(txProj.title, 'Tx Updated Title')

      // Transaction-level table whitelist enforcement
      await assert.rejects(
        async () => tx.insert('malicious_table', { title: 'bad' }),
        /Invalid or unauthorized table name/
      )

      // Transaction-level column validation enforcement
      await assert.rejects(
        async () => tx.updateById('projects', testProjectId, { 'bad"col': 'bad' }),
        /Invalid or unsafe column name/
      )
    })

    // Clean up
    await query('DELETE FROM projects WHERE id = ?', [testProjectId])
    await query('DELETE FROM users WHERE id = ?', [testUserId])
  })

  console.log('\n--- SECTION 6: E2E API Verification with Query & Sort Payloads ---')

  await asyncTest('API endpoints withstand SQL injection payloads in query and sorting params', async () => {
    const testUserId = uuidv4()
    const testEmail = `sqli_api_user_${Date.now()}@test.local`
    await insert('users', {
      id: testUserId,
      email: testEmail,
      password: '$2b$10$abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqr',
      role: 'user',
    })

    const token = generateAccessToken({ id: testUserId, email: testEmail, role: 'user' })

    const app = express()
    app.use(express.json())
    app.use('/projects', projectsRouter)

    const server = app.listen(0)
    await once(server, 'listening')
    const { port } = server.address()
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      // 1. Injected sort params
      const resSort = await fetch(`${baseUrl}/projects?sortBy=title%3B+DROP+TABLE+projects%3B+--&sortDir=ASC%3B+VACUUM%3B`, {
        headers: { authorization: `Bearer ${token}` },
      })
      assert.strictEqual(resSort.status, 200, 'Endpoint returns 200 and ignores malicious sort clause')
      const bodySort = await resSort.json()
      assert.ok(Array.isArray(bodySort), 'Returns array of projects')

      // 2. Injected pagination params
      const resPaging = await fetch(`${baseUrl}/projects?limit=-100&page=-5`, {
        headers: { authorization: `Bearer ${token}` },
      })
      assert.strictEqual(resPaging.status, 200, 'Endpoint returns 200 with clamped pagination')
      const bodyPaging = await resPaging.json()
      assert.ok(Array.isArray(bodyPaging), 'Returns array of projects')
    } finally {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve)).catch(() => {})
      await query('DELETE FROM users WHERE id = ?', [testUserId])
    }
  })

  // Cleanup queues and connections
  try {
    const { connection } = await import('../src/queue/connection.js')
    try { connection.disconnect() } catch (_) {}
    const { projectQueue } = await import('../src/queue/projectQueue.js')
    const { drainQueue } = await import('../src/queue/drainQueue.js')
    const { notifyQueue } = await import('../src/queue/notifyQueue.js')
    const { cleanupQueue } = await import('../src/queue/cleanupQueue.js')
    await Promise.all([projectQueue.close(), drainQueue.close(), notifyQueue.close(), cleanupQueue.close()].map((p) => p.catch(() => {})))
  } catch (_) {}
  await new Promise((r) => setTimeout(r, 200))

  if (failures > 0) {
    console.error(`\nTASK 14 TESTS FAILED: ${failures} failure(s)`)
    process.exit(1)
  } else {
    console.log('\nALL TASK 14 TESTS PASS')
    process.exit(0)
  }
}

run().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
