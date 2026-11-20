// Security Hardening TASK-08: IDOR / BOLA Record Access Control Test Suite
// Run: node backend/tests/securityTask08IdorBola.test.mjs
import express from 'express'
import { once } from 'node:events'
import { v4 as uuidv4 } from 'uuid'
import { initSchema } from '../src/db/schema.js'
import { insert, queryOne, run } from '../src/db/query.js'
import { generateAccessToken } from '../src/middleware/auth.js'
import projectsRouter from '../src/routes/v1/projects.js'
import composerAssetsRouter from '../src/routes/v1/composerAssets.js'
import outputsRouter from '../src/routes/v1/outputs.js'
import apiKeysRouter from '../src/routes/v1/apiKeys.js'
import {
  requireProjectOwner,
  requireOutputOwner,
  requireAssetOwner,
  requireApiKeyOwner,
  assertResourceOwnership,
  shouldHideExistence,
} from '../src/middleware/ownership.js'

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log('PASS:', msg)
  } else {
    failures++
    console.error('FAIL:', msg)
  }
}

function mockRes() {
  return {
    statusCode: null,
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

console.log('=== TASK 8: IDOR / BOLA Record Access Control Test Suite ===\n')

// 1. Direct Middleware Unit Tests
console.log('--- 1. Ownership Middleware Verification ---')
{
  const idSuffix = uuidv4().slice(0, 8)
  const userA = { id: `u_owner_a_${idSuffix}`, role: 'user' }
  const userB = { id: `u_stranger_b_${idSuffix}`, role: 'user' }
  const adminUser = { id: `u_admin_root_${idSuffix}`, role: 'admin' }

  await insert('users', { id: userA.id, email: `owner_a_${idSuffix}@test.local`, password: 'hash', role: 'user' })
  await insert('users', { id: userB.id, email: `stranger_b_${idSuffix}@test.local`, password: 'hash', role: 'user' })
  await insert('users', { id: adminUser.id, email: `admin_root_${idSuffix}@test.local`, password: 'hash', role: 'admin' })

  const projId = `proj_idor_unit_${idSuffix}`
  await insert('projects', {
    id: projId,
    user_id: userA.id,
    title: 'Owner A Private Project',
    mode: 'SUMMARY',
    copyright_acknowledged: true,
  })

  // 1.1 Owner can access project
  {
    const req = { params: { id: projId }, user: userA }
    let nextCalled = false
    await requireProjectOwner(req, mockRes(), () => { nextCalled = true })
    assert(nextCalled, 'project owner successfully passes requireProjectOwner')
    assert(req.project?.id === projId, 'req.project attached correctly')
  }

  // 1.2 Admin can access project
  {
    const req = { params: { id: projId }, user: adminUser }
    let nextCalled = false
    await requireProjectOwner(req, mockRes(), () => { nextCalled = true })
    assert(nextCalled, 'admin user successfully passes requireProjectOwner')
  }

  // 1.3 Non-owner rejected with 403 by default (backward compatible)
  {
    const req = { params: { id: projId }, user: userB }
    const res = mockRes()
    let nextCalled = false
    await requireProjectOwner(req, res, () => { nextCalled = true })
    assert(!nextCalled && res.statusCode === 403, 'stranger rejected with 403 by default')
  }

  // 1.4 Non-owner rejected with 404 when hideExistence: true (SEC-07 mitigated)
  {
    const req = { params: { id: projId }, user: userB }
    const res = mockRes()
    let nextCalled = false
    await requireProjectOwner({ hideExistence: true })(req, res, () => { nextCalled = true })
    assert(!nextCalled && res.statusCode === 404, 'stranger rejected with 404 when hideExistence: true')
  }

  // 1.5 Non-existent project returns 404
  {
    const req = { params: { id: 'non_existent_id' }, user: userA }
    const res = mockRes()
    let nextCalled = false
    await requireProjectOwner(req, res, () => { nextCalled = true })
    assert(!nextCalled && res.statusCode === 404, 'non-existent project returns 404')
  }

  // 1.6 Output Ownership: Non-owner rejected
  const outputId = `out_idor_unit_${idSuffix}`
  await insert('outputs', {
    id: outputId,
    project_id: projId,
    storage_key: 'outputs/test.mp4',
    status: 'success',
  })

  {
    const reqA = { params: { id: outputId }, user: userA }
    let nextA = false
    await requireOutputOwner(reqA, mockRes(), () => { nextA = true })
    assert(nextA, 'output owner passes requireOutputOwner')
    assert(reqA.output?.id === outputId, 'req.output attached')

    const reqB = { params: { id: outputId }, user: userB }
    const resB = mockRes()
    let nextB = false
    await requireOutputOwner(reqB, resB, () => { nextB = true })
    assert(!nextB && resB.statusCode === 403, 'stranger rejected from output with 403')

    const resB404 = mockRes()
    await requireOutputOwner({ hideExistence: true })(reqB, resB404, () => {})
    assert(resB404.statusCode === 404, 'stranger rejected with 404 when hideExistence: true')
  }

  // 1.7 Asset Ownership: Non-owner rejected
  const assetId = `asset_idor_${Date.now()}`
  await insert('assets', {
    id: assetId,
    project_id: projId,
    user_id: userA.id,
    kind: 'video',
    storage_key: 'uploads/test.mp4',
  })

  {
    const reqA = { params: { assetId }, user: userA }
    let nextA = false
    await requireAssetOwner(reqA, mockRes(), () => { nextA = true })
    assert(nextA, 'asset owner passes requireAssetOwner')

    const reqB = { params: { assetId }, user: userB }
    const resB = mockRes()
    let nextB = false
    await requireAssetOwner(reqB, resB, () => { nextB = true })
    assert(!nextB && resB.statusCode === 403, 'stranger rejected from asset with 403')
  }

  // 1.8 API Key Ownership
  const keyId = `key_idor_${Date.now()}`
  await insert('api_keys', {
    id: keyId,
    user_id: userA.id,
    provider: 'gemini',
    encrypted_key: 'v1:iv:tag:ciphertext',
    label: 'Key A',
  })

  {
    const reqA = { params: { id: keyId }, user: userA }
    let nextA = false
    await requireApiKeyOwner(reqA, mockRes(), () => { nextA = true })
    assert(nextA, 'api key owner passes requireApiKeyOwner')

    const reqB = { params: { id: keyId }, user: userB }
    const resB = mockRes()
    let nextB = false
    await requireApiKeyOwner(reqB, resB, () => { nextB = true })
    assert(!nextB && resB.statusCode === 403, 'stranger rejected from api key with 403')
  }

  // 1.9 Pure assertion helper
  {
    const owned = assertResourceOwnership({ user_id: 'u1' }, { id: 'u1', role: 'user' })
    assert(owned === true, 'assertResourceOwnership returns true for owner')

    const adminOwned = assertResourceOwnership({ user_id: 'u1' }, { id: 'u2', role: 'admin' })
    assert(adminOwned === true, 'assertResourceOwnership returns true for admin')

    let errCaught = null
    try {
      assertResourceOwnership({ user_id: 'u1' }, { id: 'u2', role: 'user' }, { hideExistence: true })
    } catch (e) {
      errCaught = e
    }
    assert(errCaught?.statusCode === 404, 'assertResourceOwnership throws 404 when hideExistence: true')
  }
}

// 2. HTTP E2E Routes IDOR Protection Tests
console.log('\n--- 2. HTTP E2E Route IDOR Verification ---')
{
  const app = express()
  app.use(express.json())
  app.use('/api/v1/projects', projectsRouter)
  app.use('/api/v1/projects', composerAssetsRouter)
  app.use('/api/v1/outputs', outputsRouter)
  app.use('/api/v1/api-keys', apiKeysRouter)

  const server = app.listen(0)
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`

  const userA = { id: uuidv4(), email: `owner_${Date.now()}@test.local`, role: 'user' }
  const userB = { id: uuidv4(), email: `stranger_${Date.now()}@test.local`, role: 'user' }
  const admin = { id: uuidv4(), email: `admin_${Date.now()}@test.local`, role: 'admin' }

  await insert('users', { id: userA.id, email: userA.email, password: 'x', role: 'user' })
  await insert('users', { id: userB.id, email: userB.email, password: 'x', role: 'user' })
  await insert('users', { id: admin.id, email: admin.email, password: 'x', role: 'admin' })

  const tokenA = generateAccessToken(userA)
  const tokenB = generateAccessToken(userB)
  const tokenAdmin = generateAccessToken(admin)

  // 2.1 User A creates a Project
  const projId = uuidv4()
  await insert('projects', {
    id: projId,
    user_id: userA.id,
    title: 'Secret Project of User A',
    mode: 'MEDIA_COMPOSER',
    copyright_acknowledged: true,
  })

  // 2.2 User B cannot view User A's project (GET /projects/:id)
  {
    const resB = await fetch(`${baseUrl}/projects/${projId}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    })
    assert(resB.status === 403 || resB.status === 404, `User B rejected from GET User A project (status=${resB.status})`)

    const resA = await fetch(`${baseUrl}/projects/${projId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    })
    assert(resA.status === 200, 'User A can view own project (200)')

    const resAdmin = await fetch(`${baseUrl}/projects/${projId}`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    })
    assert(resAdmin.status === 200, 'Admin can view any project (200)')
  }

  // 2.3 User B cannot rename or update User A's project (PATCH /projects/:id)
  {
    const resB = await fetch(`${baseUrl}/projects/${projId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hacked Title' }),
    })
    assert(resB.status === 403 || resB.status === 404, `User B rejected from PATCH User A project (status=${resB.status})`)

    const resA = await fetch(`${baseUrl}/projects/${projId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Owner Updated Title' }),
    })
    assert(resA.status === 200, 'User A can update own project (200)')
  }

  // 2.4 User B cannot access assets of User A's project (GET /projects/:id/assets)
  {
    const resB = await fetch(`${baseUrl}/projects/${projId}/assets`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    })
    assert(resB.status === 403 || resB.status === 404, `User B rejected from GET assets of User A (status=${resB.status})`)

    const resA = await fetch(`${baseUrl}/projects/${projId}/assets`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    })
    assert(resA.status === 200, 'User A can view own project assets (200)')
  }

  // 2.5 User B cannot delete User A's project (DELETE /projects/:id)
  {
    const resB = await fetch(`${baseUrl}/projects/${projId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenB}` },
    })
    assert(resB.status === 403 || resB.status === 404, `User B rejected from DELETE User A project (status=${resB.status})`)
  }

  // 2.6 User B cannot access Output of User A (GET /outputs/:id)
  const outputId = uuidv4()
  await insert('outputs', {
    id: outputId,
    project_id: projId,
    storage_key: 'outputs/test2.mp4',
    status: 'success',
  })

  {
    const resB = await fetch(`${baseUrl}/outputs/${outputId}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    })
    assert(resB.status === 403 || resB.status === 404, `User B rejected from GET output of User A (status=${resB.status})`)

    const resA = await fetch(`${baseUrl}/outputs/${outputId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    })
    assert(resA.status === 200, 'User A can view own output (200)')

    const resAdmin = await fetch(`${baseUrl}/outputs/${outputId}`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    })
    assert(resAdmin.status === 200, 'Admin can view any output (200)')
  }

  // 2.7 User B cannot mutate User A's API Keys
  const keyId = uuidv4()
  const { encrypt } = await import('../src/lib/crypto.js')
  await insert('api_keys', {
    id: keyId,
    user_id: userA.id,
    provider: 'openai',
    encrypted_key: encrypt('sk-user-a-secret-key-12345'),
    label: 'User A Secret Key',
  })

  {
    // User B tries to update User A's key -> 404
    const resBUpdate = await fetch(`${baseUrl}/api-keys/${keyId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Tampered' }),
    })
    assert(resBUpdate.status === 404, `User B rejected from updating User A API key (status=${resBUpdate.status})`)

    // User B tries to delete User A's key -> 404
    const resBDelete = await fetch(`${baseUrl}/api-keys/${keyId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenB}` },
    })
    assert(resBDelete.status === 404, `User B rejected from deleting User A API key (status=${resBDelete.status})`)

    // User A can update own key
    const resAUpdate = await fetch(`${baseUrl}/api-keys/${keyId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Renamed Key' }),
    })
    assert(resAUpdate.status === 200, 'User A can update own API key (200)')

    // Admin can delete key
    const resAdminDelete = await fetch(`${baseUrl}/api-keys/${keyId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    })
    assert(resAdminDelete.status === 200, 'Admin can delete API key (200)')
  }

  // 2.8 STRICT_IDOR_404 hides existence completely
  {
    process.env.STRICT_IDOR_404 = 'true'
    const resBStrict = await fetch(`${baseUrl}/projects/${projId}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    })
    assert(resBStrict.status === 404, `STRICT_IDOR_404 returns 404 Not Found to conceal existence (got ${resBStrict.status})`)
    delete process.env.STRICT_IDOR_404
  }

  // 2.9 User A can finally delete own project
  {
    const resADelete = await fetch(`${baseUrl}/projects/${projId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    })
    assert(resADelete.status === 200, 'User A can delete own project (200)')
  }

  server.close()
}

console.log(failures === 0 ? '\nALL TASK 8 TESTS PASS' : `\n${failures} FAILURES IN TASK 8`)
process.exit(failures === 0 ? 0 : 1)
