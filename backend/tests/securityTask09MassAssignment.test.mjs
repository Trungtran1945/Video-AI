import assert from 'node:assert'
import express from 'express'
import { once } from 'node:events'
import { v4 as uuidv4 } from 'uuid'
import { queryOne, insert, updateById } from '../src/db/query.js'
import { generateAccessToken } from '../src/middleware/auth.js'
import {
  GLOBAL_FORBIDDEN_FIELDS,
  stripForbiddenFields,
  filterAllowedFields,
  getForbiddenFieldsPresent,
  assertNoForbiddenFields,
} from '../src/lib/sanitizePayload.js'
import { protectFields, allowOnly } from '../src/middleware/massAssignment.js'
import projectsRouter from '../src/routes/v1/projects.js'
import settingsRouter from '../src/routes/v1/settings.js'
import apiKeysRouter from '../src/routes/v1/apiKeys.js'
import adminRouter from '../src/routes/v1/admin.js'

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
    console.error(`FAIL: ${name} ->`, err.message)
  }
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    },
  }
}

console.log('=== TASK 9: Mass Assignment & BOPLA Protection Test Suite ===\n')

// 1. Unit Tests for Sanitize Payload Utility
console.log('--- 1. Sanitize Payload Library Unit Tests ---')

test('GLOBAL_FORBIDDEN_FIELDS includes core security sensitive keys', () => {
  const required = ['id', 'user_id', 'role', 'password', 'refresh_token', 'is_admin']
  for (const field of required) {
    assert(GLOBAL_FORBIDDEN_FIELDS.includes(field), `contains ${field}`)
  }
})

test('stripForbiddenFields removes protected keys while preserving legitimate keys', () => {
  const dirty = {
    title: 'Legitimate Title',
    user_id: 'injected_user_id',
    role: 'admin',
    password: 'new_password',
    aspect_ratio: '16:9',
  }
  const clean = stripForbiddenFields(dirty)
  assert.strictEqual(clean.title, 'Legitimate Title')
  assert.strictEqual(clean.aspect_ratio, '16:9')
  assert.strictEqual(clean.user_id, undefined)
  assert.strictEqual(clean.role, undefined)
  assert.strictEqual(clean.password, undefined)
})

test('filterAllowedFields only preserves whitelisted fields', () => {
  const dirty = {
    title: 'Hello',
    user_id: 'bad',
    role: 'bad',
    description: 'World',
  }
  const allowed = filterAllowedFields(dirty, ['title', 'description'])
  assert.deepStrictEqual(allowed, { title: 'Hello', description: 'World' })
})

test('getForbiddenFieldsPresent correctly detects present forbidden fields', () => {
  const dirty = {
    title: 'Okay',
    user_id: 'bad',
    role: 'bad',
  }
  const present = getForbiddenFieldsPresent(dirty)
  assert.deepStrictEqual(present.sort(), ['role', 'user_id'])
})

test('assertNoForbiddenFields throws with 400 when forbidden fields exist', () => {
  let caught = null
  try {
    assertNoForbiddenFields({ title: 'Valid', role: 'admin' })
  } catch (e) {
    caught = e
  }
  assert(caught !== null, 'throws error')
  assert.strictEqual(caught.statusCode, 400)
  assert.strictEqual(caught.code, 'FORBIDDEN_FIELD')
  assert(caught.fields.includes('role'))
})

test('assertNoForbiddenFields succeeds on clean payload', () => {
  const ok = assertNoForbiddenFields({ title: 'Clean Title', aspect_ratio: '16:9' })
  assert.strictEqual(ok, true)
})

// 2. Unit Tests for Mass Assignment Middleware
console.log('\n--- 2. Mass Assignment Middleware Unit Tests ---')

test('protectFields silently strips forbidden keys in non-strict mode', () => {
  const mw = protectFields(['role', 'user_id'])
  const req = { body: { title: 'Project X', role: 'admin', user_id: 'u1' } }
  let nextCalled = false
  mw(req, mockRes(), () => { nextCalled = true })
  assert(nextCalled, 'next was called')
  assert.strictEqual(req.body.title, 'Project X')
  assert.strictEqual(req.body.role, undefined)
  assert.strictEqual(req.body.user_id, undefined)
})

test('protectFields returns 400 FORBIDDEN_FIELD in strict mode', () => {
  const mw = protectFields({ forbidden: ['role', 'user_id'], strict: true })
  const req = { body: { title: 'Project X', role: 'admin' } }
  const res = mockRes()
  let nextCalled = false
  mw(req, res, () => { nextCalled = true })
  assert(!nextCalled, 'next was NOT called')
  assert.strictEqual(res.statusCode, 400)
  assert.strictEqual(res.body.error.code, 'FORBIDDEN_FIELD')
  assert(res.body.fields.includes('role'))
})

test('allowOnly strips unallowed keys in non-strict mode', () => {
  const mw = allowOnly(['title', 'style'])
  const req = { body: { title: 'T', style: 'S', extra: 'drop me' } }
  let nextCalled = false
  mw(req, mockRes(), () => { nextCalled = true })
  assert(nextCalled)
  assert.deepStrictEqual(req.body, { title: 'T', style: 'S' })
})

// 3. Database Layer ID Tampering Prevention (updateById)
console.log('\n--- 3. Database Layer updateById Protection ---')

await asyncTest('updateById strips primary key id from SET clause to prevent PK modification', async () => {
  const testId = uuidv4()
  const user = { id: testId, email: `upd_${Date.now()}@test.local`, role: 'user' }
  await insert('users', { ...user, password: 'x' })

  const maliciousId = uuidv4()
  const updated = await updateById('users', testId, {
    id: maliciousId,
    name: 'Updated Name',
  })

  assert.strictEqual(updated.id, testId, 'id was NOT modified in returned row')
  const inDb = await queryOne('SELECT * FROM users WHERE id = ?', [testId])
  assert(inDb !== null, 'original record remains at original id')
  assert.strictEqual(inDb.name, 'Updated Name')

  const hackedRow = await queryOne('SELECT * FROM users WHERE id = ?', [maliciousId])
  assert(hackedRow === null, 'no record exists at forged id')
})

// 4. HTTP E2E Routes Mass Assignment Verification
console.log('\n--- 4. HTTP E2E Route Mass Assignment Verification ---')

{
  const app = express()
  app.use(express.json())
  app.use('/api/v1/projects', projectsRouter)
  app.use('/api/v1/settings', settingsRouter)
  app.use('/api/v1/api-keys', apiKeysRouter)
  app.use('/api/v1/admin', adminRouter)

  const server = app.listen(0)
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`

  const userA = { id: uuidv4(), email: `owner_a_${Date.now()}@test.local`, role: 'user' }
  const userB = { id: uuidv4(), email: `owner_b_${Date.now()}@test.local`, role: 'user' }
  const adminUser = { id: uuidv4(), email: `admin_root_${Date.now()}@test.local`, role: 'admin' }

  await insert('users', { id: userA.id, email: userA.email, password: 'x', role: 'user' })
  await insert('users', { id: userB.id, email: userB.email, password: 'x', role: 'user' })
  await insert('users', { id: adminUser.id, email: adminUser.email, password: 'x', role: 'admin' })

  const tokenA = generateAccessToken(userA)
  const tokenAdmin = generateAccessToken(adminUser)

  const projId = uuidv4()
  await insert('projects', {
    id: projId,
    user_id: userA.id,
    title: 'Initial Title',
    mode: 'SUMMARY',
    status: 'pending',
    aspect_ratio: '16:9',
    copyright_acknowledged: true,
  })

  // 4.1 PATCH /projects/:id with injected user_id and status
  await asyncTest('PATCH /projects/:id ignores injected user_id, status, and role', async () => {
    const res = await fetch(`${baseUrl}/projects/${projId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Safe New Title',
        user_id: userB.id,
        status: 'completed',
        role: 'admin',
      }),
    })
    assert.strictEqual(res.status, 200, `status was ${res.status}`)
    const body = await res.json()
    assert.strictEqual(body.title, 'Safe New Title')
    assert.strictEqual(body.user_id, userA.id, 'user_id was NOT reassigned to userB')
    assert.strictEqual(body.status, 'pending', 'status was NOT updated to completed')

    const inDb = await queryOne('SELECT * FROM projects WHERE id = ?', [projId])
    assert.strictEqual(inDb.user_id, userA.id, 'DB user_id remains userA')
    assert.strictEqual(inDb.status, 'pending', 'DB status remains pending')
  })

  // 4.2 PATCH /projects/:id with injected params protected keys
  await asyncTest('PATCH /projects/:id sanitizes injected keys inside params', async () => {
    const res = await fetch(`${baseUrl}/projects/${projId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        params: {
          legitOption: 'active',
          user_id: userB.id,
          role: 'admin',
          status: 'running',
        },
      }),
    })
    assert.strictEqual(res.status, 200)
    const body = await res.json()
    assert.strictEqual(body.params.legitOption, 'active')
    assert.strictEqual(body.params.user_id, undefined, 'params.user_id was stripped')
    assert.strictEqual(body.params.role, undefined, 'params.role was stripped')
    assert.strictEqual(body.params.status, undefined, 'params.status was stripped')
  })

  // 4.3 STRICT_MASS_ASSIGNMENT rejection
  await asyncTest('PATCH /projects/:id rejects with 400 when STRICT_MASS_ASSIGNMENT=true', async () => {
    process.env.STRICT_MASS_ASSIGNMENT = 'true'
    const res = await fetch(`${baseUrl}/projects/${projId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Strict Mode Title',
        user_id: userB.id,
      }),
    })
    delete process.env.STRICT_MASS_ASSIGNMENT
    assert.strictEqual(res.status, 400, `Expected 400, got ${res.status}`)
    const body = await res.json()
    assert.strictEqual(body.error.code, 'FORBIDDEN_FIELD')
    assert(body.fields.includes('user_id'))
  })

  // 4.4 PUT /settings: prevents user_id tampering
  await asyncTest('PUT /settings updates allowed settings without modifying user_id', async () => {
    const res = await fetch(`${baseUrl}/settings`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        default_language: 'vi',
        default_style: 'cinematic',
        user_id: userB.id,
      }),
    })
    assert.strictEqual(res.status, 200)
    const body = await res.json()
    assert.strictEqual(body.user_id, userA.id, 'settings user_id remains userA')
    assert.strictEqual(body.default_language, 'vi')

    const inDb = await queryOne('SELECT * FROM settings WHERE user_id = ?', [userA.id])
    assert.strictEqual(inDb.user_id, userA.id)
    assert.strictEqual(inDb.default_language, 'vi')
  })

  // 4.5 PUT /api-keys/:id: prevents user_id tampering
  await asyncTest('PUT /api-keys/:id updates label without modifying user_id or id', async () => {
    const keyId = uuidv4()
    await insert('api_keys', {
      id: keyId,
      user_id: userA.id,
      provider: 'gemini',
      label: 'Original Label',
    })

    const res = await fetch(`${baseUrl}/api-keys/${keyId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        label: 'Safe Renamed Label',
        user_id: userB.id,
        id: 'hacked_id_123',
      }),
    })
    assert.strictEqual(res.status, 200)
    const body = await res.json()
    assert.strictEqual(body.label, 'Safe Renamed Label')
    assert.strictEqual(body.id, keyId, 'api_key id was NOT modified')

    const inDb = await queryOne('SELECT * FROM api_keys WHERE id = ?', [keyId])
    assert.strictEqual(inDb.user_id, userA.id, 'api_key user_id remains userA')
    assert.strictEqual(inDb.label, 'Safe Renamed Label')
  })

  // 4.6 PUT /admin/users/:id: only role is updatable, password/token ignored
  await asyncTest('PUT /admin/users/:id updates role without touching password or refresh_token', async () => {
    const targetUser = { id: uuidv4(), email: `target_${Date.now()}@test.local`, role: 'user', password: 'original_password_hash' }
    await insert('users', targetUser)

    const res = await fetch(`${baseUrl}/admin/users/${targetUser.id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tokenAdmin}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        role: 'admin',
        password: 'malicious_overwrite_password',
        refresh_token: 'forged_token',
      }),
    })
    assert.strictEqual(res.status, 200)
    const body = await res.json()
    assert.strictEqual(body.role, 'admin')

    const inDb = await queryOne('SELECT * FROM users WHERE id = ?', [targetUser.id])
    assert.strictEqual(inDb.role, 'admin')
    assert.strictEqual(inDb.password, 'original_password_hash', 'password was NOT overwritten')
  })

  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve)).catch(() => {})
  try {
    const { connection } = await import('../src/queue/connection.js')
    try { connection.disconnect() } catch (_) {}
    const { projectQueue } = await import('../src/queue/projectQueue.js')
    const { drainQueue } = await import('../src/queue/drainQueue.js')
    const { notifyQueue } = await import('../src/queue/notifyQueue.js')
    const { cleanupQueue } = await import('../src/queue/cleanupQueue.js')
    await Promise.all([projectQueue.close(), drainQueue.close(), notifyQueue.close(), cleanupQueue.close()].map((p) => p.catch(() => {})))
  } catch (_) {}
  await new Promise((r) => setTimeout(r, 500))
}

console.log(failures === 0 ? '\nALL TASK 9 TESTS PASS' : `\n${failures} FAILURES IN TASK 9`)
process.exit(failures === 0 ? 0 : 1)
