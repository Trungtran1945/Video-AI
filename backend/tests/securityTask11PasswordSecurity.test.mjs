import assert from 'node:assert'
import express from 'express'
import { once } from 'node:events'
import { v4 as uuidv4 } from 'uuid'
import bcrypt from 'bcryptjs'
import { queryOne, insert, run } from '../src/db/query.js'
import {
  validatePasswordPolicy,
  assertPasswordPolicy,
  hashPassword,
  comparePassword,
  getBcryptRounds,
  needsRehash,
  DUMMY_BCRYPT_HASH,
  MIN_PASSWORD_CHARS,
  MAX_PASSWORD_BYTES,
  DEFAULT_BCRYPT_ROUNDS,
} from '../src/lib/password.js'
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

console.log('\n--- SECTION 1: Unit Tests for Password Library (backend/src/lib/password.js) ---')

// 1.1 validatePasswordPolicy
test('validatePasswordPolicy rejects non-string values', () => {
  assert.strictEqual(validatePasswordPolicy(null).valid, false)
  assert.strictEqual(validatePasswordPolicy(undefined).valid, false)
  assert.strictEqual(validatePasswordPolicy(12345678).valid, false)
  assert.strictEqual(validatePasswordPolicy({}).valid, false)
})

test('validatePasswordPolicy rejects empty or whitespace-only strings', () => {
  assert.strictEqual(validatePasswordPolicy('').valid, false)
  assert.strictEqual(validatePasswordPolicy('       ').valid, false)
  assert.strictEqual(validatePasswordPolicy('   \t\n   ').valid, false)
})

test('validatePasswordPolicy rejects passwords shorter than 8 characters', () => {
  assert.strictEqual(validatePasswordPolicy('1234567').valid, false)
  assert.strictEqual(validatePasswordPolicy('short').valid, false)
  assert.strictEqual(validatePasswordPolicy('a').valid, false)
})

test('validatePasswordPolicy rejects passwords exceeding 72 bytes (BCrypt truncation guard)', () => {
  // 73 ASCII characters
  const longAscii = 'a'.repeat(73)
  assert.strictEqual(Buffer.byteLength(longAscii, 'utf8'), 73)
  assert.strictEqual(validatePasswordPolicy(longAscii).valid, false)

  // Multi-byte Unicode: 20 emoji characters (each emoji is 4 UTF-8 bytes = 80 bytes)
  const unicodeLong = '🔒'.repeat(20)
  assert(Buffer.byteLength(unicodeLong, 'utf8') > 72, 'byte length exceeds 72')
  assert.strictEqual(validatePasswordPolicy(unicodeLong).valid, false)
})

test('validatePasswordPolicy accepts valid passwords (8 to 72 bytes)', () => {
  assert.strictEqual(validatePasswordPolicy('12345678').valid, true)
  assert.strictEqual(validatePasswordPolicy('SecureP@ssw0rd!2026').valid, true)
  assert.strictEqual(validatePasswordPolicy('a'.repeat(72)).valid, true)
  // Multi-byte Vietnamese within 72 bytes
  const vietnamesePass = 'MậtKhẩuBảoMật2026!'
  assert(Buffer.byteLength(vietnamesePass, 'utf8') <= 72)
  assert.strictEqual(validatePasswordPolicy(vietnamesePass).valid, true)
})

// 1.2 assertPasswordPolicy
test('assertPasswordPolicy throws INVALID_PASSWORD on violation', () => {
  assert.throws(
    () => assertPasswordPolicy('short'),
    (err) => err.code === 'INVALID_PASSWORD' && err.statusCode === 400
  )
  assert.strictEqual(assertPasswordPolicy('ValidPassword123'), true)
})

// 1.3 hashPassword
await asyncTest('hashPassword hashes with bcrypt cost 10 and per-password salt', async () => {
  const plain = 'StrongPass123!'
  const hash1 = await hashPassword(plain, 10)
  const hash2 = await hashPassword(plain, 10)

  assert(/^(\$2a|\$2b)\$10\$/.test(hash1), `hash1 format valid: ${hash1}`)
  assert(/^(\$2a|\$2b)\$10\$/.test(hash2), `hash2 format valid: ${hash2}`)
  assert.notStrictEqual(hash1, hash2, 'unique salts generate distinct hashes')
})

// 1.4 comparePassword
await asyncTest('comparePassword verifies correct password and rejects incorrect', async () => {
  const plain = 'MySecretPass2026!'
  const hash = await hashPassword(plain, 10)

  assert.strictEqual(await comparePassword(plain, hash), true)
  assert.strictEqual(await comparePassword('WrongPass2026!', hash), false)
  assert.strictEqual(await comparePassword('', hash), false)
})

await asyncTest('comparePassword safely rejects oversized inputs (> 72 bytes) without CPU DoS', async () => {
  const hash = await hashPassword('ValidPass123!', 10)
  const hugeInput = 'x'.repeat(100000)

  const start = Date.now()
  const result = await comparePassword(hugeInput, hash)
  const duration = Date.now() - start

  assert.strictEqual(result, false, 'oversized input rejected')
  assert(duration < 1000, `quick rejection without CPU stall (took ${duration}ms)`)
})

// 1.5 getBcryptRounds and needsRehash
test('getBcryptRounds parses bcrypt cost factor accurately', () => {
  assert.strictEqual(getBcryptRounds('$2a$08$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'), 8)
  assert.strictEqual(getBcryptRounds('$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'), 10)
  assert.strictEqual(getBcryptRounds('$2y$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'), 12)
  assert.strictEqual(getBcryptRounds('not-a-hash'), 0)
  assert.strictEqual(getBcryptRounds(null), 0)
})

test('needsRehash detects outdated cost factors', () => {
  const hashRound8 = '$2a$08$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'
  const hashRound10 = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'
  const hashRound12 = '$2a$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'

  assert.strictEqual(needsRehash(hashRound8, 10), true, 'round 8 needs rehash to 10')
  assert.strictEqual(needsRehash(hashRound10, 10), false, 'round 10 does not need rehash to 10')
  assert.strictEqual(needsRehash(hashRound12, 10), false, 'round 12 does not need rehash to 10')
})

console.log('\n--- SECTION 2: Integration & E2E Security Tests ---')

{
  const app = express()
  app.use(express.json())
  app.use('/api/v1/auth', authRouter)

  const server = app.listen(0)
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/auth`

  // 2.1 Backward compatibility & Automatic Rehash on Login
  await asyncTest('Login with legacy cost-8 hash succeeds and transparently rehashes to cost-10', async () => {
    if (typeof __resetAuthRateLimitsForTests === 'function') __resetAuthRateLimitsForTests()
    const plainPassword = 'LegacyPassword123!'
    // Generate an older cost-8 hash
    const legacyHash = await bcrypt.hash(plainPassword, 8)
    assert.strictEqual(getBcryptRounds(legacyHash), 8)

    const legacyUser = {
      id: uuidv4(),
      email: `legacy_user_${Date.now()}@test.local`,
      password: legacyHash,
      role: 'user',
      name: 'Legacy User',
    }
    await insert('users', legacyUser)

    // User logs in
    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: legacyUser.email, password: plainPassword }),
    })
    assert.strictEqual(res.status, 200, `login succeeded with legacy hash (got ${res.status})`)
    const body = await res.json()
    assert(body.accessToken, 'accessToken returned')

    // Verify transparent rehash in DB
    const updatedUser = await queryOne('SELECT password FROM users WHERE id = ?', [legacyUser.id])
    const newRounds = getBcryptRounds(updatedUser.password)
    assert.strictEqual(newRounds, 10, `user password upgraded to cost 10 (was 8, now ${newRounds})`)
    assert.notStrictEqual(updatedUser.password, legacyHash, 'password hash was updated in DB')

    // Subsequent login works with the updated hash
    const res2 = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: legacyUser.email, password: plainPassword }),
    })
    assert.strictEqual(res2.status, 200, 'subsequent login with upgraded hash succeeds')
  })

  // 2.2 Account Enumeration Defense in Forgot Password
  await asyncTest('POST /forgot-password returns generic response for both existing and non-existing emails', async () => {
    if (typeof __resetAuthRateLimitsForTests === 'function') __resetAuthRateLimitsForTests()
    const existingEmail = `exist_${Date.now()}@test.local`
    await insert('users', {
      id: uuidv4(),
      email: existingEmail,
      password: await hashPassword('ValidPass123!', 10),
      role: 'user',
    })

    const nonExistingEmail = `nonexist_${Date.now()}@test.local`

    const resExist = await fetch(`${baseUrl}/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: existingEmail }),
    })
    const bodyExist = await resExist.json()

    const resNonExist = await fetch(`${baseUrl}/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: nonExistingEmail }),
    })
    const bodyNonExist = await resNonExist.json()

    assert.strictEqual(resExist.status, 200)
    assert.strictEqual(resNonExist.status, 200)
    assert.strictEqual(bodyExist.message, bodyNonExist.message, 'generic message is identical')
    assert(
      bodyExist.message.includes('Nếu email tồn tại'),
      `message matches policy specification: ${bodyExist.message}`
    )
    assert.strictEqual(bodyNonExist.devToken, undefined, 'no token leaked for non-existing email')
  })

  // 2.3 Reset Password Policy & Single-Use Token
  await asyncTest('POST /reset-password enforces password policy and prevents token reuse', async () => {
    if (typeof __resetAuthRateLimitsForTests === 'function') __resetAuthRateLimitsForTests()
    const { config } = await import('../src/config.js')
    const originalDevEcho = config.authDevResetTokenInResponse
    config.authDevResetTokenInResponse = true

    try {
      const resetEmail = `reset_policy_${Date.now()}@test.local`
      const user = await insert('users', {
        id: uuidv4(),
        email: resetEmail,
        password: await hashPassword('OldPass123!', 10),
        role: 'user',
      })

      // Request reset token
      const reqForgot = await fetch(`${baseUrl}/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resetEmail }),
      })
      const forgotData = await reqForgot.json()
      const rawToken = forgotData.devToken
      assert(rawToken, 'devToken received')

      // 1. Attempt reset with weak password (< 8 chars) -> Rejected 400
      const resWeak = await fetch(`${baseUrl}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: rawToken, newPassword: 'short' }),
      })
      assert.strictEqual(resWeak.status, 400, 'short password rejected with 400')
      const weakBody = await resWeak.json()
      assert.strictEqual(weakBody.error.code, 'INVALID_PASSWORD')

      // Token must NOT be consumed
      const { sha256 } = await import('../src/lib/crypto.js')
      const tokenRow = await queryOne('SELECT used FROM reset_tokens WHERE token = ?', [sha256(rawToken)])
      assert.strictEqual(Boolean(tokenRow.used), false, 'token was NOT consumed after policy rejection')

      // 2. Reset with valid password -> Succeeds 200
      const validNewPass = 'BrandNewSecurePass2026!'
      const resSuccess = await fetch(`${baseUrl}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: rawToken, newPassword: validNewPass }),
      })
      assert.strictEqual(resSuccess.status, 200, 'reset succeeds with valid password')

      // Token is now used = 1
      const tokenUsedRow = await queryOne('SELECT used FROM reset_tokens WHERE token = ?', [sha256(rawToken)])
      assert.strictEqual(Boolean(tokenUsedRow.used), true, 'token marked used = true')

      // User password in DB is updated
      const updatedUser = await queryOne('SELECT password FROM users WHERE id = ?', [user.id])
      assert(await bcrypt.compare(validNewPass, updatedUser.password), 'new password verified in DB')

      // 3. Replay attack: reusing the same reset token -> Rejected 400
      const resReplay = await fetch(`${baseUrl}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: rawToken, newPassword: 'AnotherPassword123!' }),
      })
      assert.strictEqual(resReplay.status, 400, 'used token rejected on replay')
      const replayBody = await resReplay.json()
      assert.strictEqual(replayBody.error.code, 'INVALID_TOKEN')
    } finally {
      config.authDevResetTokenInResponse = originalDevEcho
    }
  })

  // 2.4 Registration Password Policy Enforcement
  await asyncTest('POST /register rejects invalid passwords and accepts policy-compliant ones', async () => {
    if (typeof __resetAuthRateLimitsForTests === 'function') __resetAuthRateLimitsForTests()

    // Short password (< 8 chars)
    const resShort = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `short_${Date.now()}@test.local`, password: '123' }),
    })
    assert.strictEqual(resShort.status, 400, 'short password rejected with 400')

    // Oversized password (> 72 bytes via multi-byte Unicode)
    const resOversized = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `over_${Date.now()}@test.local`,
        password: '🔐'.repeat(25), // 25 emojis * 4 bytes = 100 bytes
      }),
    })
    assert.strictEqual(resOversized.status, 400, 'oversized password rejected with 400')

    // Whitespace-only password
    const resSpaces = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `space_${Date.now()}@test.local`, password: '          ' }),
    })
    assert.strictEqual(resSpaces.status, 400, 'whitespace password rejected with 400')

    // Valid password -> Success
    const validEmail = `valid_reg_${Date.now()}@test.local`
    const resValid = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: validEmail, password: 'CompliantPassword2026!' }),
    })
    assert.strictEqual(resValid.status, 200, 'valid registration succeeds with 200')
    const validBody = await resValid.json()
    assert.strictEqual(validBody.user.email, validEmail)
  })

  // 2.5 Email OTP Brute-Force Defense
  await asyncTest('Email OTP blocks verification after exceeding maximum failed attempts', async () => {
    if (typeof __resetOtpRateLimitForTests === 'function') __resetOtpRateLimitForTests()
    process.env.DEV_OTP_EXPOSE = 'true'

    const otpEmail = `otp_brute_${Date.now()}@test.local`
    const sendRes = await fetch(`${baseUrl}/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: otpEmail }),
    })
    assert.strictEqual(sendRes.status, 200, 'send OTP succeeds')
    const sendData = await sendRes.json()
    const correctOtp = sendData.devOtp
    assert(correctOtp, 'devOtp returned')

    // 5 consecutive failed attempts
    for (let i = 1; i <= 5; i++) {
      const failRes = await fetch(`${baseUrl}/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: otpEmail, otp: '000000' }),
      })
      assert.strictEqual(failRes.status, 400, `attempt ${i} rejected with 400`)
      const failBody = await failRes.json()
      if (i < 5) {
        assert.strictEqual(failBody.remainingAttempts, 5 - i, `remainingAttempts is ${5 - i}`)
      }
    }

    // 6th attempt: exceeds max attempts -> OTP_MAX_ATTEMPTS_EXCEEDED
    const lockoutRes = await fetch(`${baseUrl}/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: otpEmail, otp: '000000' }),
    })
    assert.strictEqual(lockoutRes.status, 400, '6th attempt rejected with 400')
    const lockoutBody = await lockoutRes.json()
    assert.strictEqual(
      lockoutBody.error.code,
      'OTP_MAX_ATTEMPTS_EXCEEDED',
      `lockout returns OTP_MAX_ATTEMPTS_EXCEEDED (got ${lockoutBody.error.code})`
    )

    // Submitting the correct OTP now must still be rejected (brute force lockout)
    const bypassRes = await fetch(`${baseUrl}/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: otpEmail, otp: correctOtp }),
    })
    assert.strictEqual(bypassRes.status, 400, 'correct OTP rejected after max attempts exceeded')
    const bypassBody = await bypassRes.json()
    assert.strictEqual(bypassBody.error.code, 'OTP_MAX_ATTEMPTS_EXCEEDED')
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

console.log(failures === 0 ? '\nALL TASK 11 TESTS PASS' : `\n${failures} FAILURES IN TASK 11`)
process.exit(failures === 0 ? 0 : 1)
