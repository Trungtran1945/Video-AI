// Refresh rotation hardening (Task 1: atomic CAS rotation + HttpOnly cookie):
// - login/register/refresh never return the raw refreshToken in JSON; it lives
//   in an HttpOnly cookie (Path=/api/v1/auth, SameSite=Lax)
// - N concurrent refreshes with the SAME token -> exactly 1 winner (atomic CAS)
// - the presented token dies at rotation (no dual-token issuance)
// - deprecated body { refreshToken } input still works, through the SAME CAS
// Run: node backend/tests/refreshRotationRace.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { once } from 'node:events'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-refresh-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'
// Must be set before any src import — config.js reads env at module load.

const { initSchema } = await import('../src/db/schema.js')
const { insert, queryOne, run } = await import('../src/db/query.js')
const { generateRefreshToken, storeRefreshToken } = await import('../src/middleware/auth.js')
const authRouter = (await import('../src/routes/v1/auth.js')).default
const bcrypt = (await import('bcryptjs')).default

await initSchema()

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

const post = (p, body) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
})
const postWithCookie = (p, body, cookie) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie: `refresh_token=${cookie}` } : {}) },
  body: JSON.stringify(body || {}),
})
// JWT iat has second resolution: a token signed in the same second as the one
// it replaces is byte-identical, so the CAS WHERE clause would still match for
// every concurrent requester. Cross the second boundary before each race.
const nextSecond = () => new Promise((r) => setTimeout(r, 1100))

await insert('users', {
  id: 'rr-u1',
  email: 'rotate@test.local',
  password: await bcrypt.hash('RotatePass!123', 10),
  role: 'user',
  name: '',
})

// ── 1. login -> HttpOnly refresh cookie, NO raw refreshToken in JSON ──
let loginCookie = null
{
  const res = await post('/login', { email: 'rotate@test.local', password: 'RotatePass!123' })
  const body = await res.json()
  loginCookie = cookieOf(res)
  assert(res.status === 200 && !!loginCookie, `login tra HttpOnly refresh cookie (status=${res.status})`)
  assert(body.accessToken && !('refreshToken' in body), 'login JSON khong chua refreshToken raw')
  const setCookieHdr = res.headers.get('set-cookie') || ''
  assert(/HttpOnly/i.test(setCookieHdr), 'cookie la HttpOnly')
  assert(/Path=\/api\/v1\/auth/i.test(setCookieHdr), 'cookie Path=/api/v1/auth')
  assert(/SameSite=Lax/i.test(setCookieHdr), 'cookie SameSite=Lax')
}

// ── 2. 10 concurrent refreshes with the SAME cookie -> exactly 1 winner ──
if (loginCookie) await nextSecond()
{
  const results = await Promise.all(Array.from({ length: 10 }, () => postWithCookie('/refresh', {}, loginCookie)))
  const bodies = await Promise.all(results.map((r) => r.json()))
  const oks = results.filter((r) => r.status === 200)
  const news = oks.map((r) => cookieOf(r)).filter(Boolean)
  assert(oks.length === 1, `10 refresh dong thoi -> 1 success (thuc te ${oks.length})`)
  assert(results.filter((r) => r.status === 401).length === 9, `10 refresh dong thoi -> 9x401 (thuc te ${results.filter((r) => r.status === 401).length})`)
  assert(news.length === 1 && news[0] !== loginCookie, 'winner nhan cookie moi, khong trung cookie cu')
  const winnerBody = bodies.find((b) => b && b.accessToken) || {}
  assert(!('refreshToken' in winnerBody), 'refresh JSON khong chua refreshToken raw')

  // ── 3. old cookie is dead; the winner's cookie still works ──
  const oldRes = await postWithCookie('/refresh', {}, loginCookie)
  assert(oldRes.status === 401, `cookie cu sau rotate -> 401 (khong phat hanh 2 token hop le, got ${oldRes.status})`)
  const winnerRes = await postWithCookie('/refresh', {}, news[0])
  assert(winnerRes.status === 200, `cookie winner rotate tiep duoc (got ${winnerRes.status})`)
}

// ── 4. deprecated body input (no cookie) still works, through the SAME CAS ──
{
  const u = await queryOne(`SELECT * FROM users WHERE id = ?`, ['rr-u1'])
  const legacy = generateRefreshToken(u)
  await storeRefreshToken(u.id, legacy)
  await nextSecond()
  const legacyRes = await Promise.all(Array.from({ length: 5 }, () =>
    fetch(`${base}/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: legacy }),
    })))
  const legacyBodies = await Promise.all(legacyRes.map((r) => r.json()))
  const legacyOks = legacyRes.filter((r) => r.status === 200)
  assert(legacyOks.length === 1, `5 body refresh dong thoi -> 1 success (thuc te ${legacyOks.length})`)
  assert(legacyRes.filter((r) => r.status === 401).length === 4, `5 body refresh dong thoi -> 4x401 (thuc te ${legacyRes.filter((r) => r.status === 401).length})`)
  const legacyWinner = legacyBodies.find((b) => b && b.accessToken) || {}
  assert(!('refreshToken' in legacyWinner), 'legacy refresh JSON khong chua refreshToken raw')
}

// ── 5. frontend fences (Task 4: tokenStore + single-flight + cookie flow) ──
{
  const frontRoot = path.join(__dirname, '..', '..', 'frontend')
  const clientSrc = fs.readFileSync(path.join(frontRoot, 'src/api/client.js'), 'utf8')
  const authCtxSrc = fs.readFileSync(path.join(frontRoot, 'src/lib/AuthContext.jsx'), 'utf8')
  assert(!/localStorage\.(?:set|get|remove)Item\(\s*['"]refresh_token['"]/.test(clientSrc + authCtxSrc), 'frontend khong con cham localStorage refresh_token')
  assert(!/res\.json\(\{[^}]*refreshToken/.test(fs.readFileSync(new URL('../src/routes/v1/auth.js', import.meta.url), 'utf8')), 'auth route khong tra refreshToken trong JSON')
  assert(/createSingleFlight|refreshOnce/.test(clientSrc), 'client.js dung single-flight refresh')
  assert(!/data\.refreshToken/.test(clientSrc + authCtxSrc), 'frontend khong doc data.refreshToken')
  assert(/refreshSession/.test(authCtxSrc), 'AuthContext silent-refresh bang cookie khi reload')
}

// cleanup
server.closeAllConnections?.()
await new Promise((resolve) => server.close(resolve))
for (let i = 0; i < 100; i++) {
  const pending = process._getActiveHandles().filter((h) => h?.constructor?.name === 'Socket')
  if (pending.length === 0) break
  await new Promise((r) => setTimeout(r, 20))
}
await run(`DELETE FROM users WHERE id = 'rr-u1'`)
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
process.exit(failures === 0 ? 0 : 1)
