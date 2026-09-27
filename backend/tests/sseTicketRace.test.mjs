// SSE ticket atomic consume (Task 2):
// - 100 concurrent same-ticket requests -> exactly 1 authenticate, 99 x 401
// - ticket is single-use: request #101 after consume -> 401
// - wrong project -> 403 WITHOUT burning the correct project's ticket
// - expired ticket -> 401 (never authenticates)
// Harness: tmp DB + initSchema + bare express app mounting the REAL
// sseAuthMiddleware on a probe route (the middleware is the auth boundary;
// the real SSE route never terminates, making 100-request assertions impractical).
// Run: node tests/sseTicketRace.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { once } from 'node:events'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-sse-ticket-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'
// Must be set before any src import — config.js reads env at module load.

const { initSchema } = await import('../src/db/schema.js')
const { insert, run } = await import('../src/db/query.js')
const { sha256 } = await import('../src/lib/crypto.js')
const { sseAuthMiddleware } = await import('../src/middleware/auth.js')

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const app = express()
// Arrival barrier: Node drains a request's microtask chain before the next
// connection callback, so 100 fetches without a gate would be served one-by-one
// (no observable race, test passes with or without the fix). Hold every request
// until all 100 have arrived, then release them into sseAuthMiddleware together.
let arrived = 0
let releaseGate = null
const gate = new Promise((resolve) => { releaseGate = resolve })
app.use((req, res, next) => {
  arrived += 1
  if (arrived >= 100) releaseGate()
  gate.then(next)
})
app.get('/probe/:id', sseAuthMiddleware, (req, res) => res.json({ ok: true, user: req.user.id }))
const server = app.listen(0)
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`

await insert('users', { id: 'ss-u1', email: 'sse-race@test.local', password: 'x', role: 'user', name: '' })
await insert('projects', { id: 'ss-p1', user_id: 'ss-u1', mode: 'SUMMARY', title: 'race p1' })
await insert('projects', { id: 'ss-p2', user_id: 'ss-u1', mode: 'SUMMARY', title: 'race p2' })

const newTicket = async (projectId, expiresAt) => {
  const ticket = crypto.randomBytes(32).toString('hex')
  await run(
    `INSERT INTO sse_tickets (id, user_id, project_id, ticket_hash, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)`,
    ['ss-t-' + crypto.randomUUID(), 'ss-u1', projectId, sha256(ticket),
     expiresAt || new Date(Date.now() + 60 * 1000).toISOString()]
  )
  return ticket
}

// ── 1) 100 concurrent same-ticket -> exactly 1 success / 99 x 401 ──
{
  const ticket = await newTicket('ss-p1')
  const reqs = await Promise.all(Array.from({ length: 100 }, () =>
    fetch(`${base}/probe/ss-p1?ticket=${ticket}`)))
  const okCount = reqs.filter((r) => r.status === 200).length
  const unauth = reqs.filter((r) => r.status === 401).length
  assert(okCount === 1, `100 request cùng ticket → đúng 1 authenticate (thực tế ${okCount})`)
  assert(unauth === 99, `99 request bị 401 (thực tế ${unauth})`)

  // ── 2) ticket đã consume -> request thứ 101 cũng 401 (single-use) ──
  const again = await fetch(`${base}/probe/ss-p1?ticket=${ticket}`)
  assert(again.status === 401, `ticket reuse sau consume → 401 (thực tế ${again.status})`)
}

// ── 3) sai project -> 403, và KHÔNG đốt ticket của project đúng ──
{
  const ticket2 = await newTicket('ss-p1')
  const wrong = await fetch(`${base}/probe/ss-p2?ticket=${ticket2}`)
  assert(wrong.status === 403, `sai project → 403 (thực tế ${wrong.status})`)
  const right = await fetch(`${base}/probe/ss-p1?ticket=${ticket2}`)
  assert(right.status === 200, `403 không consume ticket → probe đúng project vẫn 200 (thực tế ${right.status})`)
}

// ── 4) expired ticket -> 401 + không authenticate ──
{
  const expired = await newTicket('ss-p1', new Date(Date.now() - 1000).toISOString())
  const res = await fetch(`${base}/probe/ss-p1?ticket=${expired}`)
  assert(res.status === 401, `expired ticket → 401 (thực tế ${res.status})`)
  const body = await res.json().catch(() => null)
  assert(!(body && body.ok), 'expired ticket không authenticate (handler không chạy)')
}

// cleanup
server.closeAllConnections?.()
await new Promise((resolve) => server.close(resolve))
for (let i = 0; i < 100; i++) {
  const pending = process._getActiveHandles().filter((h) => h?.constructor?.name === 'Socket')
  if (pending.length === 0) break
  await new Promise((r) => setTimeout(r, 20))
}
await run(`DELETE FROM sse_tickets`)
await run(`DELETE FROM projects WHERE id IN ('ss-p1', 'ss-p2')`)
await run(`DELETE FROM users WHERE id = 'ss-u1'`)
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
process.exit(failures === 0 ? 0 : 1)
