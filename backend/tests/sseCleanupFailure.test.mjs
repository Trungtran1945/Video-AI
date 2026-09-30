// SSE ticket cleanup failure: expired-ticket DELETE fails → issuance survives.
// Contract: cleanup is best-effort (observable via sse_ticket_cleanup_error)
// and must never break the INSERT when the INSERT itself succeeds.
// Fault injection: BEFORE DELETE trigger that aborts cleanup DELETEs only;
// INSERTs are unaffected, so a 200 proves the failure was contained.
// Run: node backend/tests/sseCleanupFailure.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { once } from 'node:events'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_sse_cleanup_fail_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, run, queryOne } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const eventsRouter = (await import('../src/routes/v1/events.js')).default

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const user = { id: 'u-sse-cleanfail', email: 'cleanfail@test.local', role: 'user', password: 'pw' }
await insert('users', user)
const token = generateAccessToken(user)
const pid = `p-cleanfail-${Date.now()}`
await insert('projects', { id: pid, user_id: user.id, mode: 'TRANSLATE_DUB', title: 'cleanfail', status: 'running', progress: 5 })

const app = express()
app.use(express.json())
app.use('/api/v1', eventsRouter)
const server = app.listen(0)
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`

async function postTicket() {
  const res = await fetch(`${base}/api/v1/projects/${pid}/sse-ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

// 1. Source fence: cleanup failure is contained + observable.
{
  const src = fs.readFileSync(new URL('../src/routes/v1/events.js', import.meta.url), 'utf8')
  assert(src.includes('sse_ticket_cleanup_error'), 'cleanup failure emits observable diagnostic')
  const ticketBlock = src.slice(src.indexOf('sse-ticket'), src.indexOf('res.json({ ticket'))
  assert(!/catch\s*\(\s*_\s*\)\s*\{\s*\}/.test(ticketBlock), 'cleanup no longer silently swallowed')
  assert(ticketBlock.includes('INSERT INTO sse_tickets'), 'INSERT proceeds after cleanup attempt')
}

// 2. Live: cleanup DELETE aborts, INSERT still issues a usable ticket.
{
  // Seed an expired row so the cleanup DELETE actually deletes (trigger only
  // fires per deleted row; with zero expired rows nothing throws).
  await insert('sse_tickets', {
    id: 'ss-expired-1',
    user_id: user.id,
    project_id: pid,
    ticket_hash: 'expired-hash-placeholder',
    expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
    used: 0,
  })
  await run(`CREATE TRIGGER sse_cleanup_fail BEFORE DELETE ON sse_tickets
    BEGIN SELECT RAISE(ABORT, 'cleanup boom'); END`)

  const warnings = []
  const origWarn = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  let result
  try {
    result = await postTicket()
  } finally {
    console.warn = origWarn
  }

  assert(result.status === 200, `ticket issuance survives cleanup failure (got ${result.status})`)
  assert(result.body && typeof result.body.ticket === 'string' && result.body.ticket.length > 0, 'response carries a fresh ticket')
  assert(warnings.some((w) => w.includes('sse_ticket_cleanup_error')), 'sse_ticket_cleanup_error diagnostic emitted')
  assert(!warnings.some((w) => /[a-f0-9]{32,}|Bearer|eyJ/i.test(w)), 'diagnostic leaks no ticket/token')

  // The issued ticket is real: its hash is stored and consumable by SSE auth.
  const { sha256 } = await import('../src/lib/crypto.js')
  const row = await queryOne('SELECT * FROM sse_tickets WHERE ticket_hash = ?', [sha256(result.body.ticket)])
  assert(row && row.project_id === pid, 'issued ticket row persisted despite cleanup failure')

  await run('DROP TRIGGER sse_cleanup_fail')
}

// 3. Normal issuance still works after trigger removal.
{
  const result = await postTicket()
  assert(result.status === 200 && result.body?.ticket, 'issuance healthy after cleanup fault removed')
}

await new Promise((r) => server.close(r))
try { fs.rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
if (failures > 0) process.exit(1)
