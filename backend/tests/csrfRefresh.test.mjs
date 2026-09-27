// Task 4: same-origin cookie policy + light CSRF for /refresh + /logout:
// - cookie + Origin:https://evil.test -> 403 CSRF_ORIGIN_MISMATCH (no rotation)
// - cookie + no Origin/Referer -> 200 (same-origin / non-browser)
// - cookie + evil Referer -> 403
// - bearer-only route (GET /me) with evil Origin -> 200 (untouched)
// Same-origin enforced at edge via nginx :80 + Vite proxy (/api -> 3001).
// Run: node backend/tests/csrfRefresh.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { once } from 'node:events'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-csrf-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'
// Must be set before any src import — config.js reads env at module load.

const { initSchema } = await import('../src/db/schema.js')
const { insert, run } = await import('../src/db/query.js')
const authRouter = (await import('../src/routes/v1/auth.js')).default
const { connection } = await import('../src/queue/connection.js')
const bcrypt = (await import('bcryptjs')).default

await initSchema()
// No live Redis in tests: detach the eager ioredis socket (redisGuard pattern).
try { connection.disconnect() } catch (_) {}

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const cookieOf = (res) => {
  const raw = res.headers.get('set-cookie') || ''
  const m = raw.match(/refresh_token=([^;]+)/)
  return m ? m[1] : null
}

const app = express()
app.use(express.json())
app.use('/api/v1/auth', authRouter)
const server = app.listen(0)
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}/api/v1/auth`

const postRefresh = (cookie, extraHeaders = {}) => fetch(`${base}/refresh`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(cookie ? { cookie: `refresh_token=${cookie}` } : {}),
    ...extraHeaders,
  },
  body: JSON.stringify({}),
})

await insert('users', {
  id: 'csrf-u1',
  email: 'csrf@test.local',
  password: await bcrypt.hash('CsrfPass!123', 10),
  role: 'user',
  name: '',
})

const loginRes = await fetch(`${base}/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'csrf@test.local', password: 'CsrfPass!123' }),
})
const loginBody = await loginRes.json().catch(() => ({}))
const c1 = cookieOf(loginRes)
assert(loginRes.status === 200 && !!c1 && !!loginBody.accessToken, `login cap cookie (status=${loginRes.status})`)

// ── 1. cookie + evil Origin -> 403 CSRF_ORIGIN_MISMATCH, no rotation ──
{
  const res = await postRefresh(c1, { origin: 'https://evil.test' })
  const body = await res.json().catch(() => ({}))
  const code = body?.error?.code || body?.code
  assert(res.status === 403, `evil Origin refresh -> 403 (got ${res.status})`)
  assert(code === 'CSRF_ORIGIN_MISMATCH', `evil Origin code=CSRF_ORIGIN_MISMATCH (got ${code})`)
}

// ── 2. same cookie + no Origin -> 200 (blocked attempt did not rotate) ──
let c2 = null
{
  const res = await postRefresh(c1)
  const body = await res.json().catch(() => ({}))
  c2 = cookieOf(res)
  assert(res.status === 200, `no-Origin refresh -> 200 (got ${res.status})`)
  assert(!!body.accessToken && !!c2, 'no-Origin refresh tra accessToken + cookie moi')
}

// ── 3. cookie + evil Referer -> 403 ──
{
  const res = await postRefresh(c2, { referer: 'https://evil.test/page' })
  const body = await res.json().catch(() => ({}))
  const code = body?.error?.code || body?.code
  assert(res.status === 403, `evil Referer refresh -> 403 (got ${res.status})`)
  assert(code === 'CSRF_ORIGIN_MISMATCH', `evil Referer code=CSRF_ORIGIN_MISMATCH (got ${code})`)
}

// ── 4. bearer-only route unaffected by evil Origin ──
{
  const res = await fetch(`${base}/me`, {
    headers: { authorization: `Bearer ${loginBody.accessToken}`, origin: 'https://evil.test' },
  })
  assert(res.status === 200, `GET /me bearer + evil Origin -> 200 (got ${res.status})`)
}

// ── 5. logout: evil Origin blocked, no-Origin succeeds ──
{
  const evil = await fetch(`${base}/logout`, {
    method: 'POST',
    headers: { cookie: `refresh_token=${c2}`, origin: 'https://evil.test' },
  })
  assert(evil.status === 403, `evil Origin logout -> 403 (got ${evil.status})`)
  const ok = await fetch(`${base}/logout`, {
    method: 'POST',
    headers: { cookie: `refresh_token=${c2}` },
  })
  assert(ok.status === 200, `no-Origin logout -> 200 (got ${ok.status})`)
}

// cleanup
server.closeAllConnections?.()
await new Promise((resolve) => server.close(resolve))
for (let i = 0; i < 100; i++) {
  const pending = process._getActiveHandles().filter((h) => h?.constructor?.name === 'Socket')
  if (pending.length === 0) break
  await new Promise((r) => setTimeout(r, 20))
}
await run(`DELETE FROM users WHERE id = 'csrf-u1'`)
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
process.exit(failures === 0 ? 0 : 1)
