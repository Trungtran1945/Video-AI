import assert from 'node:assert'
import express from 'express'
import { once } from 'node:events'
import { v4 as uuidv4 } from 'uuid'
import bcrypt from 'bcryptjs'
import { queryOne, insert } from '../src/db/query.js'
import { generateAccessToken, generateRefreshToken } from '../src/middleware/auth.js'
import {
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  getRefreshCookieOptions,
  getClearRefreshCookieOptions,
} from '../src/lib/cookieOptions.js'
import { cookieCsrf } from '../src/middleware/cookieCsrf.js'
import authRouter from '../src/routes/v1/auth.js'

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

console.log('=== TASK 10: Cookie & CSRF Security Hardening Test Suite ===\n')

// 1. Cookie Options Library Unit Tests
console.log('--- 1. Cookie Options Unit Tests ---')

test('getRefreshCookieOptions defaults to secure standards', () => {
  const opts = getRefreshCookieOptions()
  assert.strictEqual(opts.httpOnly, true, 'httpOnly is true')
  assert.strictEqual(opts.path, '/api/v1/auth', 'path restricted to auth')
  assert.strictEqual(opts.sameSite, 'lax', 'sameSite is lax by default')
  assert(opts.maxAge > 0, 'maxAge is set')
})

test('getRefreshCookieOptions respects overrides and env config', () => {
  process.env.COOKIE_SAMESITE = 'strict'
  const opts = getRefreshCookieOptions({ secure: true })
  delete process.env.COOKIE_SAMESITE
  assert.strictEqual(opts.sameSite, 'strict')
  assert.strictEqual(opts.secure, true)
})

test('getClearRefreshCookieOptions has matching attributes without maxAge', () => {
  const opts = getClearRefreshCookieOptions()
  assert.strictEqual(opts.httpOnly, true)
  assert.strictEqual(opts.path, '/api/v1/auth')
  assert.strictEqual(opts.maxAge, undefined, 'maxAge must be undefined for clear')
})

// 2. Cookie CSRF Middleware Unit Tests
console.log('\n--- 2. Cookie CSRF Middleware Unit Tests ---')

test('cookieCsrf passes through requests without refresh cookie', () => {
  const mw = cookieCsrf()
  const req = { headers: { origin: 'https://evil.test' } }
  let nextCalled = false
  mw(req, mockRes(), () => { nextCalled = true })
  assert.strictEqual(nextCalled, true, 'requests without cookie are untouched')
})

test('cookieCsrf blocks Sec-Fetch-Site: cross-site requests', () => {
  const mw = cookieCsrf()
  const req = {
    headers: {
      cookie: 'refresh_token=secret_token_123',
      'sec-fetch-site': 'cross-site',
    },
  }
  const res = mockRes()
  let nextCalled = false
  mw(req, res, () => { nextCalled = true })
  assert.strictEqual(nextCalled, false)
  assert.strictEqual(res.statusCode, 403)
  assert.strictEqual(res.body.error.code, 'CSRF_ORIGIN_MISMATCH')
})

test('cookieCsrf blocks disallowed Origin', () => {
  const mw = cookieCsrf()
  const req = {
    headers: {
      cookie: 'refresh_token=secret_token_123',
      origin: 'https://evil-attacker.com',
    },
  }
  const res = mockRes()
  let nextCalled = false
  mw(req, res, () => { nextCalled = true })
  assert.strictEqual(nextCalled, false)
  assert.strictEqual(res.statusCode, 403)
  assert.strictEqual(res.body.error.code, 'CSRF_ORIGIN_MISMATCH')
})

test('cookieCsrf blocks disallowed Referer', () => {
  const mw = cookieCsrf()
  const req = {
    headers: {
      cookie: 'refresh_token=secret_token_123',
      referer: 'https://evil-attacker.com/malicious/page',
    },
  }
  const res = mockRes()
  let nextCalled = false
  mw(req, res, () => { nextCalled = true })
  assert.strictEqual(nextCalled, false)
  assert.strictEqual(res.statusCode, 403)
  assert.strictEqual(res.body.error.code, 'CSRF_ORIGIN_MISMATCH')
})

test('SEC-09: cookieCsrf fails closed on malformed unparseable Referer', () => {
  const mw = cookieCsrf()
  const req = {
    headers: {
      cookie: 'refresh_token=secret_token_123',
      referer: 'javascript:alert(1)',
    },
  }
  const res = mockRes()
  let nextCalled = false
  mw(req, res, () => { nextCalled = true })
  assert.strictEqual(nextCalled, false, 'unparseable referer must NOT bypass')
  assert.strictEqual(res.statusCode, 403)
  assert.strictEqual(res.body.error.code, 'CSRF_ORIGIN_MISMATCH')
})

test('cookieCsrf allows valid localhost or 127.0.0.1 Origin in development/test', () => {
  const mw = cookieCsrf()
  const req = {
    headers: {
      cookie: 'refresh_token=secret_token_123',
      origin: 'http://localhost:5173',
    },
  }
  let nextCalled = false
  mw(req, mockRes(), () => { nextCalled = true })
  assert.strictEqual(nextCalled, true)
})

test('cookieCsrf allows valid Referer matching allowed origin', () => {
  const mw = cookieCsrf()
  const req = {
    headers: {
      cookie: 'refresh_token=secret_token_123',
      referer: 'http://localhost:5173/dashboard',
    },
  }
  let nextCalled = false
  mw(req, mockRes(), () => { nextCalled = true })
  assert.strictEqual(nextCalled, true)
})

test('cookieCsrf in strict mode blocks requests lacking both Origin and Referer', () => {
  const mw = cookieCsrf({ strict: true })
  const req = {
    headers: {
      cookie: 'refresh_token=secret_token_123',
    },
  }
  const res = mockRes()
  let nextCalled = false
  mw(req, res, () => { nextCalled = true })
  assert.strictEqual(nextCalled, false)
  assert.strictEqual(res.statusCode, 403)
  assert.strictEqual(res.body.error.code, 'CSRF_CHECK_FAILED')
})

// 3. HTTP E2E Routes Verification
console.log('\n--- 3. HTTP E2E Cookie & Session Verification ---')

{
  const app = express()
  app.use(express.json())
  app.use('/api/v1/auth', authRouter)

  const server = app.listen(0)
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/auth`

  const passwordPlain = 'CookiePass_2026!Sec'
  const passwordHash = await bcrypt.hash(passwordPlain, 10)
  const user = {
    id: uuidv4(),
    email: `cookie_test_${Date.now()}@test.local`,
    password: passwordHash,
    role: 'user',
  }
  await insert('users', user)

  let capturedCookie = null

  // 3.1 Login sets secure cookie
  await asyncTest('POST /login sets HttpOnly refresh_token cookie with restricted path', async () => {
    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: passwordPlain }),
    })
    assert.strictEqual(res.status, 200)
    const setCookie = res.headers.get('set-cookie') || ''
    assert(setCookie.includes('refresh_token='), 'contains refresh_token')
    assert(/HttpOnly/i.test(setCookie), 'cookie has HttpOnly')
    assert(/Path=\/api\/v1\/auth/i.test(setCookie), 'cookie has Path=/api/v1/auth')
    assert(/SameSite=Lax/i.test(setCookie), 'cookie has SameSite=Lax')

    const body = await res.json()
    assert(body.accessToken, 'accessToken returned in body')
    assert.strictEqual(body.refreshToken, undefined, 'raw refreshToken is NOT in response body')

    const match = setCookie.match(/refresh_token=([^;]+)/)
    capturedCookie = match ? match[1] : null
    assert(capturedCookie !== null, 'capturedCookie extracted')
  })

  // 3.2 Refresh rejected on evil Origin
  await asyncTest('POST /refresh rejected when Origin is untrusted', async () => {
    const res = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `refresh_token=${capturedCookie}`,
        Origin: 'https://malicious-site.com',
      },
    })
    assert.strictEqual(res.status, 403)
    const body = await res.json()
    assert.strictEqual(body.error.code, 'CSRF_ORIGIN_MISMATCH')
  })

  // 3.3 Refresh rejected on evil Referer
  await asyncTest('POST /refresh rejected when Referer is untrusted', async () => {
    const res = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `refresh_token=${capturedCookie}`,
        Referer: 'https://malicious-site.com/exploit',
      },
    })
    assert.strictEqual(res.status, 403)
    const body = await res.json()
    assert.strictEqual(body.error.code, 'CSRF_ORIGIN_MISMATCH')
  })

  // 3.4 Refresh succeeds with trusted origin
  let newCookie = null
  await asyncTest('POST /refresh succeeds with trusted origin and rotates cookie', async () => {
    // Cross the second boundary so JWT iat changes
    await new Promise((r) => setTimeout(r, 1100))

    const res = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `refresh_token=${capturedCookie}`,
        Origin: 'http://localhost:5173',
      },
    })
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`)
    const setCookie = res.headers.get('set-cookie') || ''
    assert(setCookie.includes('refresh_token='), 'rotated cookie provided')

    const match = setCookie.match(/refresh_token=([^;]+)/)
    newCookie = match ? match[1] : null
    assert(newCookie !== null && newCookie !== capturedCookie, 'cookie rotated to a new token')
  })

  // 3.5 Logout clears cookie and invalidates DB refresh token
  await asyncTest('POST /logout clears cookie and revokes session in DB', async () => {
    const res = await fetch(`${baseUrl}/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `refresh_token=${newCookie}`,
        Origin: 'http://localhost:5173',
      },
    })
    assert.strictEqual(res.status, 200)
    const setCookie = res.headers.get('set-cookie') || ''
    // res.clearCookie sets max-age=0 or expires in past
    assert(
      setCookie.includes('refresh_token=;') ||
      /max-age=0/i.test(setCookie) ||
      /expires=Thu, 01 Jan 1970/i.test(setCookie),
      'Set-Cookie clears refresh_token'
    )

    const inDb = await queryOne('SELECT refresh_token FROM users WHERE id = ?', [user.id])
    assert.strictEqual(inDb.refresh_token, null, 'DB refresh_token cleared to NULL')
  })

  // 3.6 Password reset clears cookie and invalidates active refresh session
  await asyncTest('POST /reset-password clears cookie and revokes refresh session', async () => {
    // Set a live refresh session for testing
    const { sha256 } = await import('../src/lib/crypto.js')
    const liveToken = generateRefreshToken(user)
    const liveTokenHash = sha256(liveToken)
    const rawResetToken = `valid-reset-token-${uuidv4()}`
    await insert('reset_tokens', {
      token: sha256(rawResetToken),
      email: user.email,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      used: false,
    })
    const { run } = await import('../src/db/query.js')
    await run('UPDATE users SET refresh_token = ? WHERE id = ?', [liveTokenHash, user.id])

    const res = await fetch(`${baseUrl}/reset-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `refresh_token=${liveToken}`,
      },
      body: JSON.stringify({
        token: rawResetToken,
        newPassword: 'BrandNewPassword123!',
      }),
    })
    assert.strictEqual(res.status, 200)
    const setCookie = res.headers.get('set-cookie') || ''
    assert(
      setCookie.includes('refresh_token=;') ||
      /max-age=0/i.test(setCookie) ||
      /expires=Thu, 01 Jan 1970/i.test(setCookie),
      'Set-Cookie clears refresh_token on password reset'
    )

    const inDb = await queryOne('SELECT id, email, refresh_token FROM users WHERE id = ?', [user.id])
    assert.strictEqual(inDb.refresh_token, null, 'Active refresh session revoked on password reset')
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

console.log(failures === 0 ? '\nALL TASK 10 TESTS PASS' : `\n${failures} FAILURES IN TASK 10`)
process.exit(failures === 0 ? 0 : 1)
