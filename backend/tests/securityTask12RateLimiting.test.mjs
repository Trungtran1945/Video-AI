import assert from 'node:assert'
import express from 'express'
import { once } from 'node:events'
import { v4 as uuidv4 } from 'uuid'
import { queryOne, insert } from '../src/db/query.js'
import { hashPassword } from '../src/lib/password.js'
import {
  normalizeRateLimitKey,
  hitRateLimit,
  checkRateLimit,
  recordRateLimitHit,
  resetRateLimitKey,
  resetAllRateLimits,
  createRateLimiter,
} from '../src/middleware/rateLimiter.js'
import authRouter, { __resetAuthRateLimitsForTests, __resetOtpRateLimitForTests } from '../src/routes/v1/auth.js'

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

console.log('\n--- SECTION 1: Unit Tests for Rate Limiter Library (backend/src/middleware/rateLimiter.js) ---')

// 1.1 Key normalization
test('normalizeRateLimitKey trims and lowercases inputs to prevent bypass', () => {
  assert.strictEqual(normalizeRateLimitKey('  USER@EXAMPLE.COM  '), 'user@example.com')
  assert.strictEqual(normalizeRateLimitKey('127.0.0.1  '), '127.0.0.1')
  assert.strictEqual(normalizeRateLimitKey(null), 'unknown')
  assert.strictEqual(normalizeRateLimitKey(undefined), 'unknown')
  assert.strictEqual(normalizeRateLimitKey(12345), '12345')
})

// 1.2 hitRateLimit sliding window
test('hitRateLimit allows requests up to limit and blocks on exceeding', () => {
  const store = new Map()
  const key = 'test-client-1'
  const limit = 3
  const windowMs = 60 * 1000
  const now = Date.now()

  // 1st, 2nd, 3rd hits are allowed (return 0)
  assert.strictEqual(hitRateLimit(store, key, limit, windowMs, now), 0)
  assert.strictEqual(hitRateLimit(store, key, limit, windowMs, now + 100), 0)
  assert.strictEqual(hitRateLimit(store, key, limit, windowMs, now + 200), 0)

  // 4th hit exceeds limit (returns retryAfterSec > 0)
  const waitSec = hitRateLimit(store, key, limit, windowMs, now + 300)
  assert(waitSec > 0 && waitSec <= 60, `returns positive retryAfterSec: ${waitSec}`)

  // Hits after window expires are allowed again
  const afterWindow = now + windowMs + 1000
  assert.strictEqual(hitRateLimit(store, key, limit, windowMs, afterWindow), 0)
})

// 1.3 checkRateLimit & recordRateLimitHit
test('checkRateLimit inspects without consuming, recordRateLimitHit increments', () => {
  const store = new Map()
  const key = 'check-key'
  const limit = 2
  const windowMs = 60 * 1000
  const now = Date.now()

  // Initially not limited
  assert.strictEqual(checkRateLimit(store, key, limit, windowMs, now), 0)

  // Record 1 failure
  recordRateLimitHit(store, key, windowMs, now)
  assert.strictEqual(checkRateLimit(store, key, limit, windowMs, now), 0)

  // Record 2nd failure -> reaches limit
  recordRateLimitHit(store, key, windowMs, now)
  const waitSec = checkRateLimit(store, key, limit, windowMs, now)
  assert(waitSec > 0, `lockout detected: ${waitSec}s`)

  // Resetting key clears lockout
  resetRateLimitKey(store, key)
  assert.strictEqual(checkRateLimit(store, key, limit, windowMs, now), 0)
})

// 1.4 createRateLimiter Middleware Factory
await asyncTest('createRateLimiter middleware sets standard headers and blocks on limit', async () => {
  const customLimiter = createRateLimiter({
    windowMs: 10 * 1000,
    limit: 2,
    prefix: 'custom_test',
    message: 'Too many test requests.',
  })

  const app = express()
  app.use(express.json())
  app.get('/test-endpoint', customLimiter, (req, res) => res.json({ success: true }))

  const server = app.listen(0)
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/test-endpoint`

  try {
    // Request 1: 200
    const res1 = await fetch(url)
    assert.strictEqual(res1.status, 200)
    assert.strictEqual(res1.headers.get('x-ratelimit-limit'), '2')

    // Request 2: 200
    const res2 = await fetch(url)
    assert.strictEqual(res2.status, 200)

    // Request 3: 429 Too Many Requests
    const res3 = await fetch(url)
    assert.strictEqual(res3.status, 429)
    assert.strictEqual(res3.headers.get('x-ratelimit-remaining'), '0')
    const retryAfter = res3.headers.get('retry-after')
    assert(retryAfter !== null && parseInt(retryAfter, 10) > 0, `has Retry-After header: ${retryAfter}`)

    const body3 = await res3.json()
    assert.strictEqual(body3.code, 'RATE_LIMITED')
    assert.strictEqual(body3.error?.code, 'RATE_LIMITED')
    assert(body3.retryAfterSec > 0, 'body contains retryAfterSec')
  } finally {
    server.close()
  }
})

console.log('\n--- SECTION 2: Integration & E2E Security Tests ---')

{
  const app = express()
  app.use(express.json())
  app.use('/api/v1/auth', authRouter)

  const server = app.listen(0)
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/auth`

  // 2.1 Login Rate Limiting & Account Lockout Defense
  await asyncTest('POST /login locks account temporarily after 5 failed attempts with Retry-After header', async () => {
    __resetAuthRateLimitsForTests()
    const targetEmail = `brute_target_${Date.now()}@test.local`
    const correctPassword = 'Password123!Secure'

    await insert('users', {
      id: uuidv4(),
      email: targetEmail,
      password: await hashPassword(correctPassword, 10),
      role: 'user',
    })

    // 5 consecutive wrong password attempts
    for (let i = 1; i <= 5; i++) {
      const res = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: targetEmail, password: 'WrongPassword!' }),
      })
      assert.strictEqual(res.status, 401, `attempt ${i} rejected with 401`)
      const body = await res.json()
      assert.strictEqual(body.error.code, 'INVALID_CREDENTIALS')
    }

    // 6th attempt: triggers 429 Account Lockout
    const lockRes = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: targetEmail, password: 'WrongPassword!' }),
    })
    assert.strictEqual(lockRes.status, 429, `6th attempt returns 429 (got ${lockRes.status})`)
    const lockBody = await lockRes.json()
    assert.strictEqual(lockBody.error.code, 'RATE_LIMITED')
    const retryAfter = lockRes.headers.get('retry-after')
    assert(retryAfter !== null && parseInt(retryAfter, 10) > 0, `Retry-After header present: ${retryAfter}`)
    assert(lockBody.message.includes('quá 5 lần'), `lockout message mentions failed count: ${lockBody.message}`)

    // Verify casing normalization: uppercase email hits the SAME lockout bucket
    const caseRes = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: targetEmail.toUpperCase(), password: correctPassword }),
    })
    assert.strictEqual(caseRes.status, 429, 'uppercase email variation cannot bypass account lockout')

    // Resetting for tests enables login again
    __resetAuthRateLimitsForTests()
    const successRes = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: targetEmail, password: correctPassword }),
    })
    assert.strictEqual(successRes.status, 200, 'login succeeds after lockout reset')
  })

  // 2.2 Registration IP Rate Limiter
  await asyncTest('POST /register enforces 10 req/15min IP rate limit and returns Retry-After', async () => {
    __resetAuthRateLimitsForTests()
    const ip = '198.51.100.42'

    // First 10 registration requests succeed
    for (let i = 1; i <= 10; i++) {
      const res = await fetch(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ email: `valid_email_${i}_${Date.now()}@test.local`, password: 'ValidPassword123!' }),
      })
      assert.strictEqual(res.status, 200, `request ${i} succeeds with 200`)
    }

    // 11th request: blocked by IP rate limit with 429
    const blockedRes = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ email: `another_${Date.now()}@test.local`, password: 'ValidPassword123!' }),
    })
    assert.strictEqual(blockedRes.status, 429, '11th registration request returns 429')
    const blockedBody = await blockedRes.json()
    assert.strictEqual(blockedBody.error.code, 'RATE_LIMITED')
    const retryAfter = blockedRes.headers.get('retry-after')
    assert(retryAfter !== null && parseInt(retryAfter, 10) > 0, `Retry-After header present: ${retryAfter}`)
  })

  // 2.3 Forgot Password Rate Limiting (IP & Email)
  await asyncTest('POST /forgot-password enforces IP (5/10m) and Email (3/1h) rate limits with Retry-After', async () => {
    __resetAuthRateLimitsForTests()
    const email = `forgot_limit_${Date.now()}@test.local`

    // Email rate limit: 3 requests per hour
    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${baseUrl}/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      assert.strictEqual(res.status, 200, `forgot password request ${i} succeeds`)
    }

    // 4th request for this email -> 429 RATE_LIMITED
    const blockedEmailRes = await fetch(`${baseUrl}/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    assert.strictEqual(blockedEmailRes.status, 429, '4th request for same email returns 429')
    const bodyEmail = await blockedEmailRes.json()
    assert.strictEqual(bodyEmail.error.code, 'RATE_LIMITED')
    const retryAfter = blockedEmailRes.headers.get('retry-after')
    assert(retryAfter !== null && parseInt(retryAfter, 10) > 0, `Retry-After header present: ${retryAfter}`)
  })

  // 2.4 OTP Request Cooldown & Rate Limiting
  await asyncTest('POST /otp/send enforces 60s cooldown between requests with Retry-After', async () => {
    __resetOtpRateLimitForTests()
    const otpEmail = `cooldown_${Date.now()}@test.local`

    // First send succeeds
    const res1 = await fetch(`${baseUrl}/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: otpEmail }),
    })
    assert.strictEqual(res1.status, 200, 'first OTP send succeeds')

    // Immediate second send fails with 429 cooldown
    const res2 = await fetch(`${baseUrl}/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: otpEmail }),
    })
    assert.strictEqual(res2.status, 429, 'immediate second OTP send returns 429')
    const body2 = await res2.json()
    assert.strictEqual(body2.error.code, 'RATE_LIMITED')
    const retryAfter = res2.headers.get('retry-after')
    assert(retryAfter !== null && parseInt(retryAfter, 10) > 0, `Retry-After header present: ${retryAfter}`)
  })

  // Cleanup server
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

console.log(failures === 0 ? '\nALL TASK 12 TESTS PASS' : `\n${failures} FAILURES IN TASK 12`)
process.exit(failures === 0 ? 0 : 1)
