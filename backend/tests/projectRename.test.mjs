import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { once } from 'node:events'
import assert from 'node:assert/strict'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-rename-http-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'

const { initSchema } = await import('../src/db/schema.js')
const { insert, query, queryOne, run } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const projectsMod = await import('../src/routes/v1/projects.js')
const projectsRouter = projectsMod.default
const { connection } = await import('../src/queue/connection.js')

await initSchema()
try { connection.disconnect() } catch (_) {}

console.log('=== Project Rename PATCH /projects/:id API Tests ===\n')

const testUser1 = { id: 'user-rename-1', email: 'rename-1@test.local', role: 'user' }
const testUser2 = { id: 'user-rename-2', email: 'rename-2@test.local', role: 'user' }

await insert('users', { id: testUser1.id, email: testUser1.email, role: 'user', password: 'hash' })
await insert('users', { id: testUser2.id, email: testUser2.email, role: 'user', password: 'hash' })

const token1 = generateAccessToken(testUser1)
const token2 = generateAccessToken(testUser2)

const app = express()
app.use(express.json())
app.use('/api/v1/projects', projectsRouter)

const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/api/v1/projects`

try {
  const projectId = 'proj-rename-test-1'
  await insert('projects', {
    id: projectId,
    user_id: testUser1.id,
    title: 'Original Title',
    mode: 'MEDIA_COMPOSER',
    status: 'queued',
  })

  // 1. Unauthenticated request -> 401
  console.log('--- 1. PATCH /projects/:id without token returns 401 ---')
  const unauthRes = await fetch(`${baseUrl}/${projectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'New Title' }),
  })
  assert.equal(unauthRes.status, 401, 'Unauthenticated request rejected with 401')

  // 2. Non-owner request -> 403
  console.log('--- 2. PATCH /projects/:id by non-owner returns 403 ---')
  const nonOwnerRes = await fetch(`${baseUrl}/${projectId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token2}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: 'Hijacked Title' }),
  })
  assert.equal(nonOwnerRes.status, 403, 'Non-owner rejected with 403')

  // 3. Non-existent project -> 404
  console.log('--- 3. PATCH /projects/:id with invalid ID returns 404 ---')
  const notFoundRes = await fetch(`${baseUrl}/non-existent-project-id`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: 'Ghost Project' }),
  })
  assert.equal(notFoundRes.status, 404, 'Non-existent project returns 404')

  // 4. Missing or non-string title -> 400
  console.log('--- 4. Missing or invalid title type returns 400 ---')
  for (const invalidTitle of [undefined, null, 12345, true, {}, []]) {
    const res = await fetch(`${baseUrl}/${projectId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token1}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: invalidTitle }),
    })
    assert.equal(res.status, 400, `Rejected invalid title: ${JSON.stringify(invalidTitle)}`)
  }

  // 5. Empty or whitespace-only title -> 400
  console.log('--- 5. Empty or whitespace-only title returns 400 ---')
  for (const emptyTitle of ['', '   ', '\t\n ']) {
    const res = await fetch(`${baseUrl}/${projectId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token1}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: emptyTitle }),
    })
    assert.equal(res.status, 400, `Rejected whitespace title`)
  }

  // 6. Title exceeding 200 characters -> 400
  console.log('--- 6. Title exceeding 200 chars returns 400 ---')
  const longTitle = 'A'.repeat(201)
  const tooLongRes = await fetch(`${baseUrl}/${projectId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: longTitle }),
  })
  assert.equal(tooLongRes.status, 400, 'Title > 200 characters rejected with 400')

  // 7. Successful rename -> 200 & returns updated project
  console.log('--- 7. Successful rename returns 200 and updated DTO ---')
  const newTitle = 'Dự án Video Marketing Tết 2026'
  const patchRes = await fetch(`${baseUrl}/${projectId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: `   ${newTitle}   ` }), // Test trim
  })
  assert.equal(patchRes.status, 200, 'PATCH returns 200')
  const patchData = await patchRes.json()
  assert.equal(patchData.id, projectId, 'Correct project ID')
  assert.equal(patchData.title, newTitle, 'Title trimmed and updated')
  assert.ok(patchData.updated_at, 'updated_at timestamp populated')

  // 8. Direct DB check
  console.log('--- 8. Direct database verification ---')
  const dbRow = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
  assert.equal(dbRow.title, newTitle, 'DB title matches updated title')
  assert.equal(dbRow.updated_at, patchData.updated_at, 'DB updated_at matches response')

  // 9. GET /projects/:id returns updated title
  console.log('--- 9. GET /projects/:id reflects renamed title ---')
  const getRes = await fetch(`${baseUrl}/${projectId}`, {
    headers: { Authorization: `Bearer ${token1}` },
  })
  assert.equal(getRes.status, 200)
  const getData = await getRes.json()
  assert.equal(getData.title, newTitle, 'GET project has new title')

  console.log('\nALL PASS: Project rename PATCH /projects/:id tests passed 100%.')
} finally {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve)).catch(() => {})
  try {
    const { connection } = await import('../src/queue/connection.js')
    try { connection.disconnect() } catch (_) {}
    const { projectQueue } = await import('../src/queue/projectQueue.js')
    const { drainQueue } = await import('../src/queue/drainQueue.js')
    const { notifyQueue } = await import('../src/queue/notifyQueue.js')
    const { cleanupQueue } = await import('../src/queue/cleanupQueue.js')
    await Promise.all([projectQueue?.close?.(), drainQueue?.close?.(), notifyQueue?.close?.(), cleanupQueue?.close?.()].map((p) => p?.catch?.(() => {})))
  } catch (_) {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (_) {}
  await new Promise((r) => setTimeout(r, 500))
  process.exit(0)
}
