// SSE unauthorized & access control tests (4.6 & 4.8)
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import express from 'express'
import { once } from 'node:events'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_sse_unauth_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, run } = await import('../src/db/query.js')
const { sha256 } = await import('../src/lib/crypto.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const eventBus = (await import('../src/pipeline/eventBus.js')).default
const eventsRouter = (await import('../src/routes/v1/events.js')).default

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const owner = { id: 'u-owner-sse', email: 'owner@test.local', role: 'user', password: 'pw' }
const stranger = { id: 'u-stranger-sse', email: 'stranger@test.local', role: 'user', password: 'pw' }
await insert('users', owner)
await insert('users', stranger)

const ownerToken = generateAccessToken(owner)
const strangerToken = generateAccessToken(stranger)

const projectId = `p-auth-${Date.now()}`
await insert('projects', { id: projectId, user_id: owner.id, mode: 'TRANSLATE_DUB', title: 'auth check', status: 'running', progress: 10 })

const app = express()
app.use(express.json())
app.use('/api/v1', eventsRouter)
const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port

const baseUrl = `http://127.0.0.1:${port}/api/v1/projects/${projectId}/events`

// 1. No auth header and no ticket -> 401
{
  const res = await fetch(baseUrl)
  assert(res.status === 401, 'no auth header -> 401')
  assert(eventBus.listenerCount(`project:${projectId}`) === 0, 'no listener registered on 401')
}

// 2. Invalid bearer token -> 401
{
  const res = await fetch(baseUrl, { headers: { authorization: 'Bearer invalid-token-xyz' } })
  assert(res.status === 401, 'invalid bearer -> 401')
  assert(eventBus.listenerCount(`project:${projectId}`) === 0, 'no listener registered on invalid token')
}

// 3. Stranger tries to access owner project -> 403 Forbidden
{
  const res = await fetch(baseUrl, { headers: { authorization: `Bearer ${strangerToken}` } })
  assert(res.status === 403, 'non-owner receives 403')
  assert(eventBus.listenerCount(`project:${projectId}`) === 0, 'no listener registered on 403')
}

// 4. Ticket for another project -> 403
{
  const otherProjectId = `p-other-${Date.now()}`
  await insert('projects', { id: otherProjectId, user_id: owner.id, mode: 'TRANSLATE_DUB', title: 'other', status: 'running', progress: 5 })

  const ticket = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 60000).toISOString()
  await insert('sse_tickets', {
    id: `tick-${Date.now()}`,
    user_id: owner.id,
    project_id: otherProjectId,
    ticket_hash: sha256(ticket),
    expires_at: expiresAt,
    used: 0,
  })

  // Try to use ticket for otherProjectId on projectId
  const res = await fetch(`${baseUrl}?ticket=${ticket}`)
  assert(res.status === 403, 'ticket belonging to other project -> 403')
  assert(eventBus.listenerCount(`project:${projectId}`) === 0, 'no listener registered on 403')
}

// 5. Expired ticket -> 401
{
  const ticket = crypto.randomBytes(32).toString('hex')
  const expiredAt = new Date(Date.now() - 5000).toISOString()
  await insert('sse_tickets', {
    id: `tick-exp-${Date.now()}`,
    user_id: owner.id,
    project_id: projectId,
    ticket_hash: sha256(ticket),
    expires_at: expiredAt,
    used: 0,
  })
  const res = await fetch(`${baseUrl}?ticket=${ticket}`)
  assert(res.status === 401, 'expired ticket -> 401')
  assert(eventBus.listenerCount(`project:${projectId}`) === 0, 'no listener registered on expired ticket')
}

// 6. Valid single-use ticket: succeeds once, second use fails with 401
{
  const ticket = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 60000).toISOString()
  await insert('sse_tickets', {
    id: `tick-valid-${Date.now()}`,
    user_id: owner.id,
    project_id: projectId,
    ticket_hash: sha256(ticket),
    expires_at: expiresAt,
    used: 0,
  })

  // First use with abort controller
  const ac = new AbortController()
  const res1 = await fetch(`${baseUrl}?ticket=${ticket}`, { signal: ac.signal })
  assert(res1.status === 200, 'first use of valid ticket succeeds (200)')
  ac.abort()

  // Second use with the same ticket
  const res2 = await fetch(`${baseUrl}?ticket=${ticket}`)
  assert(res2.status === 401, 'second use of consumed single-use ticket returns 401')
}

await new Promise((r) => server.close(r))
try { (await import('node:fs')).rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
if (failures > 0) process.exit(1)
