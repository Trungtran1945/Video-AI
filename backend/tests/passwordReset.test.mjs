// Password-reset hardening:
// - DB stores only sha256(token); the raw token is never logged
// - raw token is echoed in the response ONLY with AUTH_DEV_RESET_TOKEN_IN_RESPONSE=true
// - the echo flag is forced off in production regardless of env (spawned config check)
// Run: node backend/tests/passwordReset.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import express from 'express'
import { once } from 'node:events'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.join(__dirname, '..')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-reset-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'
// Must be set before any src import — config.js reads env at module load.
process.env.AUTH_DEV_RESET_TOKEN_IN_RESPONSE = 'true'

const { initSchema } = await import('../src/db/schema.js')
const { insert, queryOne, run } = await import('../src/db/query.js')
const { sha256 } = await import('../src/lib/crypto.js')
const authRouter = (await import('../src/routes/v1/auth.js')).default
const bcrypt = (await import('bcryptjs')).default

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// Capture console.log to prove the raw token is never written to server logs
// (test's own PASS lines are also captured, but never contain the token).
const logged = []
const originalLog = console.log
console.log = (...args) => { logged.push(args.map(String).join(' ')); originalLog(...args) }

const app = express()
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

await insert('users', { id: 'rp-u1', email: 'reset@test.local', password: 'x', role: 'user', name: '' })

// 1. forgot-password: dev echo on, hash-only storage, raw token never logged
let devToken = null
{
  const res = await post('/forgot-password', { email: 'reset@test.local' })
  const body = await res.json()
  assert(res.status === 200, `forgot-password succeeds (got ${res.status})`)
  assert(typeof body.devToken === 'string' && body.devToken.length > 0, 'dev echo returns the raw token when the flag is on')
  devToken = body.devToken

  const row = await queryOne('SELECT token FROM reset_tokens WHERE email = ?', ['reset@test.local'])
  assert(row && /^[0-9a-f]{64}$/.test(row.token), 'DB stores only a sha256 hex hash')
  assert(row.token === sha256(devToken), 'stored hash equals sha256(raw token) — DB leak cannot reveal the token')
  assert(row.token !== devToken, 'raw token is not stored in the DB')
}

// 2. unknown email: same generic 200, no token material
{
  const res = await post('/forgot-password', { email: 'nobody@test.local' })
  const body = await res.json()
  assert(res.status === 200, `unknown email still returns 200 to avoid account leaks (got ${res.status})`)
  assert(body.devToken === undefined, 'no dev token echoed for an unknown email')
  assert(typeof body.message === 'string', 'generic message preserved')
}

// 3. reset flow: raw token accepted, password re-hashed, token single-use
{
  const res = await post('/reset-password', { token: devToken, newPassword: 'NewPass!234' })
  assert(res.status === 200, `reset-password accepts the raw token (got ${res.status})`)
  const u = await queryOne('SELECT password FROM users WHERE id = ?', ['rp-u1'])
  assert(await bcrypt.compare('NewPass!234', u.password), 'password was updated to the new bcrypt hash')

  const reuse = await post('/reset-password', { token: devToken, newPassword: 'Another!234' })
  assert(reuse.status === 400, `used token cannot be reused (got ${reuse.status})`)
}

// 4. forged token is rejected
{
  const res = await post('/reset-password', { token: 'deadbeef'.repeat(8), newPassword: 'x' })
  assert(res.status === 400, `forged reset token is rejected (got ${res.status})`)
}

// 5. raw token never appeared in any captured server log
{
  console.log = originalLog
  assert(!logged.some((l) => l.includes(devToken)), 'raw reset token is never written to server logs')
}

// 6. production forces the echo flag off even when env var is true
{
  const script = `
    process.env.NODE_ENV = 'production'
    process.env.AUTH_DEV_RESET_TOKEN_IN_RESPONSE = 'true'
    process.env.JWT_ACCESS_SECRET = 'p'.repeat(40)
    process.env.JWT_REFRESH_SECRET = 'q'.repeat(40)
    process.env.MASTER_KEY = 'r'.repeat(40)
    process.env.CORS_ORIGINS = 'https://example.com'
    const { config } = await import('./src/config.js')
    console.log('FLAG=' + config.authDevResetTokenInResponse)
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: backendRoot,
    encoding: 'utf8',
  })
  assert(out.includes('FLAG=false'), 'dev echo flag is forced off in production regardless of env var')
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
await run("DELETE FROM users WHERE id = 'rp-u1'")
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log('ALL PASS')
process.exit(failures === 0 ? 0 : 1)
