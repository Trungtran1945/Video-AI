import assert from 'node:assert'
import express from 'express'
import { once } from 'node:events'
import { v4 as uuidv4 } from 'uuid'
import { queryOne, insert } from '../src/db/query.js'
import { hashPassword } from '../src/lib/password.js'
import { canonicalizeEmail, isEmailCanonicalEquivalent } from '../src/lib/emailCanonical.js'
import {
  verifyTurnstileToken,
  isSuspiciousUserAgent,
  botProtection,
  __setTurnstileVerifierForTest,
  __resetTurnstileVerifierForTest,
} from '../src/middleware/botProtection.js'
import authRouter, { __resetAuthRateLimitsForTests } from '../src/routes/v1/auth.js'
import { generateNumericOtp, hashOtp, OTP_TTL_SECONDS } from '../src/services/emailService.js'

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

console.log('\n--- SECTION 1: Unit Tests for Email Canonicalization (SEC-05) ---')

// 1.1 Gmail / Googlemail alias canonicalization
test('canonicalizeEmail strips dots, plus-aliases, and normalizes googlemail for Gmail', () => {
  assert.strictEqual(canonicalizeEmail('john.doe@gmail.com'), 'johndoe@gmail.com')
  assert.strictEqual(canonicalizeEmail('j.o.h.n.d.o.e@gmail.com'), 'johndoe@gmail.com')
  assert.strictEqual(canonicalizeEmail('johndoe+promo123@gmail.com'), 'johndoe@gmail.com')
  assert.strictEqual(canonicalizeEmail('  J.Doe+Tag.Spam@Googlemail.com  '), 'jdoe@gmail.com')
  assert.strictEqual(canonicalizeEmail('user.name+anything@gmail.com'), 'username@gmail.com')
})

// 1.2 Other email domains
test('canonicalizeEmail handles other domains (removes plus alias, keeps dots)', () => {
  assert.strictEqual(canonicalizeEmail('jane.doe+work@outlook.com'), 'jane.doe@outlook.com')
  assert.strictEqual(canonicalizeEmail('  ADMIN+ALERT@COMPANY.COM  '), 'admin@company.com')
  assert.strictEqual(canonicalizeEmail(''), '')
  assert.strictEqual(canonicalizeEmail(null), '')
})

// 1.3 isEmailCanonicalEquivalent
test('isEmailCanonicalEquivalent identifies identical inboxes despite alias variations', () => {
  assert.strictEqual(
    isEmailCanonicalEquivalent('alice.smith@gmail.com', 'alicesmith+freecoins@googlemail.com'),
    true
  )
  assert.strictEqual(
    isEmailCanonicalEquivalent('user1@gmail.com', 'user2@gmail.com'),
    false
  )
})

console.log('\n--- SECTION 2: Unit Tests for Bot Protection & Turnstile ---')

// 2.1 Turnstile verification hook
await asyncTest('verifyTurnstileToken bypasses when unconfigured and validates when configured', async () => {
  const originalSecret = process.env.TURNSTILE_SECRET_KEY
  delete process.env.TURNSTILE_SECRET_KEY

  // When unconfigured -> safe bypass
  const unconfResult = await verifyTurnstileToken('any-token', '127.0.0.1')
  assert.strictEqual(unconfResult.success, true)
  assert.strictEqual(unconfResult.bypassed, true)

  // When mocked verification is configured
  __setTurnstileVerifierForTest(async (token) => {
    if (token === 'valid-turnstile-token') return { success: true }
    if (!token) return { success: false, code: 'MISSING_CAPTCHA', message: 'Token required' }
    return { success: false, code: 'CAPTCHA_FAILED', message: 'Invalid token' }
  })

  try {
    const valid = await verifyTurnstileToken('valid-turnstile-token', '127.0.0.1')
    assert.strictEqual(valid.success, true)

    const invalid = await verifyTurnstileToken('bad-token', '127.0.0.1')
    assert.strictEqual(invalid.success, false)
    assert.strictEqual(invalid.code, 'CAPTCHA_FAILED')

    const missing = await verifyTurnstileToken('', '127.0.0.1')
    assert.strictEqual(missing.success, false)
    assert.strictEqual(missing.code, 'MISSING_CAPTCHA')
  } finally {
    __resetTurnstileVerifierForTest()
    if (originalSecret) process.env.TURNSTILE_SECRET_KEY = originalSecret
  }
})

// 2.2 User-Agent inspection
test('isSuspiciousUserAgent detects known automated scraper signatures', () => {
  assert.strictEqual(isSuspiciousUserAgent('curl/7.88.1'), true)
  assert.strictEqual(isSuspiciousUserAgent('python-requests/2.31.0'), true)
  assert.strictEqual(isSuspiciousUserAgent('Wget/1.21.3 (linux-gnu)'), true)
  assert.strictEqual(
    isSuspiciousUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'),
    false
  )
  assert.strictEqual(isSuspiciousUserAgent(''), false)
  assert.strictEqual(isSuspiciousUserAgent(null), false)
})

console.log('\n--- SECTION 3: Integration & E2E Security Tests ---')

{
  const app = express()
  app.use(express.json())
  app.use('/api/v1/auth', authRouter)

  const server = app.listen(0)
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/auth`

  // 3.1 Account Creation Alias Multiplication Defense (SEC-05)
  await asyncTest('Prevents registering multiple accounts with Gmail dot / plus-addressing aliases', async () => {
    __resetAuthRateLimitsForTests()
    const baseLocal = `alias_test_${Date.now()}`
    const originalEmail = `${baseLocal}.initial@gmail.com`
    const canonical = `${baseLocal}initial@gmail.com`

    // 1. Register with original email
    const res1 = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: originalEmail,
        password: 'SecurePassword123!',
        name: 'Original Account',
      }),
    })
    assert.strictEqual(res1.status, 200, `first registration succeeds (got ${res1.status})`)
    const body1 = await res1.json()
    assert.strictEqual(body1.user.email, canonical, 'user stored with canonical email')

    // 2. Attempt to register alias with extra dots and plus-tag -> 409 EMAIL_EXISTS
    const aliasEmail = `${baseLocal}i.n.i.t.i.a.l+freepromo@googlemail.com`
    const res2 = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: aliasEmail,
        password: 'AnotherPassword123!',
        name: 'Spam Account',
      }),
    })
    assert.strictEqual(res2.status, 409, `alias variation rejected with 409 EMAIL_EXISTS (got ${res2.status})`)
    const body2 = await res2.json()
    assert.strictEqual(body2.error.code, 'EMAIL_EXISTS')
  })

  // 3.2 Mandatory Registration OTP Enforcement (SEC-04)
  await asyncTest('Enforces registration OTP when REQUIRE_REGISTRATION_OTP=true and allows valid OTP', async () => {
    __resetAuthRateLimitsForTests()
    const origFlag = process.env.REQUIRE_REGISTRATION_OTP
    process.env.REQUIRE_REGISTRATION_OTP = 'true'

    try {
      const regEmail = `req_otp_${Date.now()}@test.local`

      // 1. Registration without OTP -> Rejected with 400 OTP_REQUIRED
      const resNoOtp = await fetch(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: regEmail,
          password: 'ValidPassword123!',
        }),
      })
      assert.strictEqual(resNoOtp.status, 400, 'registration without OTP rejected with 400')
      const bodyNoOtp = await resNoOtp.json()
      assert.strictEqual(bodyNoOtp.error.code, 'OTP_REQUIRED')

      // 2. Registration with invalid OTP -> Rejected with 400 INVALID_OTP
      const resBadOtp = await fetch(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: regEmail,
          password: 'ValidPassword123!',
          otp: '999999',
        }),
      })
      assert.strictEqual(resBadOtp.status, 400, 'registration with invalid OTP rejected with 400')
      const bodyBadOtp = await resBadOtp.json()
      assert.strictEqual(bodyBadOtp.error.code, 'INVALID_OTP')

      // 3. Generate and seed valid OTP in DB
      const validCode = generateNumericOtp(6)
      const now = Date.now()
      await insert('email_otps', {
        id: uuidv4(),
        email: canonicalizeEmail(regEmail),
        otp_hash: hashOtp(validCode),
        purpose: 'register',
        expires_at: new Date(now + OTP_TTL_SECONDS * 1000).toISOString(),
        attempts: 0,
        max_attempts: 5,
        used: 0,
        created_date: new Date(now).toISOString(),
      })

      // 4. Registration with valid OTP -> Succeeds 200
      const resSuccess = await fetch(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: regEmail,
          password: 'ValidPassword123!',
          otp: validCode,
        }),
      })
      assert.strictEqual(resSuccess.status, 200, `registration with valid OTP succeeds (got ${resSuccess.status})`)
      const bodySuccess = await resSuccess.json()
      assert.strictEqual(bodySuccess.user.email_verified, true, 'user email_verified is true')

      // 5. OTP is marked used = 1 in DB
      const otpRow = await queryOne('SELECT used FROM email_otps WHERE email = ?', [canonicalizeEmail(regEmail)])
      assert.strictEqual(Boolean(otpRow.used), true, 'OTP marked used after successful registration')
    } finally {
      if (origFlag !== undefined) {
        process.env.REQUIRE_REGISTRATION_OTP = origFlag
      } else {
        delete process.env.REQUIRE_REGISTRATION_OTP
      }
    }
  })

  // 3.3 BotProtection Middleware Hook
  await asyncTest('botProtection middleware blocks missing or invalid Turnstile token when active', async () => {
    const protectedApp = express()
    protectedApp.use(express.json())

    __setTurnstileVerifierForTest(async (token) => {
      if (token === 'good-human-token') return { success: true }
      return { success: false, code: 'CAPTCHA_FAILED', message: 'Bot verification failed' }
    })

    try {
      protectedApp.post(
        '/guarded-action',
        botProtection({ enforce: true, action: 'sensitive_submit' }),
        (req, res) => res.json({ success: true })
      )

      const srv = protectedApp.listen(0)
      await once(srv, 'listening')
      const targetUrl = `http://127.0.0.1:${srv.address().port}/guarded-action`

      try {
        // Without token -> 403
        const resNoToken = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: 'payload' }),
        })
        assert.strictEqual(resNoToken.status, 403)
        const bodyNoToken = await resNoToken.json()
        assert.strictEqual(bodyNoToken.error.code, 'CAPTCHA_FAILED')

        // With valid token -> 200
        const resValidToken = await fetch(targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'cf-turnstile-response': 'good-human-token',
          },
          body: JSON.stringify({ data: 'payload' }),
        })
        assert.strictEqual(resValidToken.status, 200)
      } finally {
        srv.close()
      }
    } finally {
      __resetTurnstileVerifierForTest()
    }
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

console.log(failures === 0 ? '\nALL TASK 13 TESTS PASS' : `\n${failures} FAILURES IN TASK 13`)
process.exit(failures === 0 ? 0 : 1)
