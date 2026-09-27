// Password-reset atomic consume race (Task 3):
// - 100 concurrent same-token resets -> exactly 1 x 200, 99 x 400: the
//   conditional claim (UPDATE ... used=1 WHERE used=0 AND expires_at>now)
//   decides the single winner; the password update rides the SAME transaction
// - password changed exactly once (bcrypt.compare against the new password)
// - token consumed: a later sequential reset with the same token -> 400
// - refresh token revoked in the same tx -> refresh with the old token -> 401
// - DB never holds the raw token: reset_tokens.token === sha256(devToken) and
//   the raw devToken appears nowhere in the persisted DB bytes
// Arrival barrier (see sseTicketRace.test.mjs): without a gate the 100 fetches
// can drain serially and the test would pass even against a broken
// check-then-act implementation. A timeout releases a starved gate so the
// assert fails instead of hanging the runner.
// Run: node backend/tests/passwordResetRace.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { once } from 'node:events'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-reset-race-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'
// Must be set before any src import — config.js reads env at module load.
process.env.AUTH_DEV_RESET_TOKEN_IN_RESPONSE = 'true'

const { initSchema } = await import('../src/db/schema.js')
const { insert, queryOne, run } = await import('../src/db/query.js')
const { sha256 } = await import('../src/lib/crypto.js')
const { generateRefreshToken, storeRefreshToken } = await import('../src/middleware/auth.js')
const authRouter = (await import('../src/routes/v1/auth.js')).default
const bcrypt = (await import('bcryptjs')).default

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const RACE_TOTAL = 100
const app = express()
// Arrival barrier: hold every reset-password request until all RACE_TOTAL have
// arrived, then release them into the handler together.
let arrived = 0
let releasedBy = null
let releaseGate = null
const gate = new Promise((resolve) => { releaseGate = resolve })
const gateTimer = setTimeout(() => {
  if (!releasedBy) { releasedBy = 'timeout'; releaseGate() }
}, 5000)
app.use((req, res, next) => {
  if (!req.path.endsWith('/reset-password')) return next()
  arrived += 1
  if (arrived >= RACE_TOTAL && !releasedBy) {
    releasedBy = 'barrier'
    clearTimeout(gateTimer)
    releaseGate()
  }
  gate.then(next)
})
app.use(express.json())
app.use('/api/v1/auth', authRouter)
const server = app.listen(0)
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}/api/v1/auth`
const post = (p, body) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const USER_ID = 'prace-u1'
const EMAIL = 'resetrace@test.local'
await insert('users', { id: USER_ID, email: EMAIL, password: 'x', role: 'user', name: '' })

// forgot-password → devToken
let devToken = null
{
  const res = await post('/forgot-password', { email: EMAIL })
  const body = await res.json()
  assert(res.status === 200, `forgot-password succeeds (got ${res.status})`)
  assert(typeof body.devToken === 'string' && body.devToken.length > 0, 'dev echo returns the raw token when the flag is on')
  devToken = body.devToken
}

// Chuẩn bị: user có refresh token hợp lệ (storeRefreshToken từ middleware/auth)
const userRow = await queryOne('SELECT * FROM users WHERE id = ?', [USER_ID])
const oldRefresh = generateRefreshToken(userRow)
await storeRefreshToken(USER_ID, oldRefresh)

// 100 concurrent POST /reset-password { token: devToken, newPassword }
{
  const results = await Promise.all(Array.from({ length: RACE_TOTAL }, () =>
    post('/reset-password', { token: devToken, newPassword: 'MatKhauMoi_123!' })))
  assert(releasedBy === 'barrier' && arrived >= RACE_TOTAL,
    `arrival barrier released all ${RACE_TOTAL} requests together (releasedBy=${releasedBy}, arrived=${arrived})`)
  const oks = results.filter((r) => r.status === 200)
  const bads = results.filter((r) => r.status === 400)
  assert(oks.length === 1, `100 reset đồng thời → 1 success (thực tế ${oks.length})`)
  assert(bads.length === 99, `99 reset bị 400 (thực tế ${bads.length})`)
}

// password đã đổi đúng 1 lần (bcrypt.compare với mật khẩu mới → true)
{
  const u = await queryOne('SELECT password FROM users WHERE id = ?', [USER_ID])
  assert(await bcrypt.compare('MatKhauMoi_123!', u.password), 'password was updated to exactly the new bcrypt hash')
}

// token bị consume: reset lần nữa (sequential) → 400
{
  const res = await post('/reset-password', { token: devToken, newPassword: 'MatKhauMoi_Khac_456!' })
  assert(res.status === 400, `consumed token reused sequentially → 400 (got ${res.status})`)
}

// refresh token bị thu hồi: refresh bằng token cũ → 401
{
  const res = await fetch(`${base}/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: oldRefresh }),
  })
  assert(res.status === 401, `refresh with the pre-reset token → 401 (got ${res.status})`)
}

// DB không lưu raw token: row.token === sha256(devToken), không có devToken anywhere in DB bytes
{
  const row = await queryOne('SELECT token FROM reset_tokens WHERE email = ?', [EMAIL])
  assert(!!row && row.token === sha256(devToken), 'DB stores only sha256(devToken) for the consumed token')
  const bytes = fs.readFileSync(process.env.DB_PATH)
  const raw = Buffer.from(devToken, 'utf8')
  const rawUtf16 = Buffer.from(devToken, 'utf16le')
  assert(!bytes.includes(raw) && !bytes.includes(rawUtf16), 'raw devToken appears nowhere in the persisted DB bytes')
}

// cleanup
server.closeAllConnections?.()
await new Promise((resolve) => server.close(resolve))
for (let i = 0; i < 100; i++) {
  const pending = process._getActiveHandles().filter((h) => h?.constructor?.name === 'Socket')
  if (pending.length === 0) break
  await new Promise((r) => setTimeout(r, 20))
}
await run('DELETE FROM reset_tokens')
await run(`DELETE FROM users WHERE id = '${USER_ID}'`)
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
process.exit(failures === 0 ? 0 : 1)
