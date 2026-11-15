// Test suite: Google ID Token Authentication Security, Unit & Integration Tests
// Run: node backend/tests/googleAuthSecurity.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { once } from 'node:events'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-google-sec-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'
process.env.GOOGLE_CLIENT_ID = 'test-client-id-12345.apps.googleusercontent.com'

const { initSchema } = await import('../src/db/schema.js')
const { insert, queryOne, query, run } = await import('../src/db/query.js')
const { config } = await import('../src/config.js')
config.googleClientId = process.env.GOOGLE_CLIENT_ID
if (!config.google) config.google = {}
config.google.clientId = process.env.GOOGLE_CLIENT_ID

const {
  verifyGoogleIdToken,
  __setGoogleOAuthClientForTest,
  __resetGoogleOAuthClientForTest,
} = await import('../src/services/googleAuthService.js')

const authRouter = (await import('../src/routes/v1/auth.js')).default
const { __resetAuthRateLimitsForTests } = await import('../src/routes/v1/auth.js')

await initSchema()

let failures = 0
const assert = (c, m) => {
  if (c) {
    console.log('PASS:', m)
  } else {
    failures++
    console.error('FAIL:', m)
  }
}

const app = express()
app.use(express.json())
app.use('/api/v1/auth', authRouter)
const server = app.listen(0)
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}/api/v1/auth`

const post = (p, body, headers = {}) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

function createMockOAuth2Client(handler) {
  return {
    verifyIdToken: async (params) => {
      return handler(params)
    },
  }
}

console.log('=== Google ID Token Authentication Security & Unit Tests ===')

// -------------------------------------------------------------
// SECTION 1: googleAuthService.js Direct Unit Tests
// -------------------------------------------------------------
console.log('\n--- 1. googleAuthService: Unit Tests for verifyGoogleIdToken ---')
{
  const nowSec = Math.floor(Date.now() / 1000)
  const validPayload = {
    iss: 'https://accounts.google.com',
    aud: config.googleClientId,
    sub: 'google-sub-unit-001',
    email: 'unit.test@example.com',
    name: 'Unit Tester',
    picture: 'https://lh3.googleusercontent.com/avatar.jpg',
    email_verified: true,
    exp: nowSec + 3600,
  }

  // 1a. Valid token returns clean verified profile
  __setGoogleOAuthClientForTest(
    createMockOAuth2Client(async ({ idToken }) => {
      if (idToken === 'valid-id-token') {
        return { getPayload: () => ({ ...validPayload }) }
      }
      throw new Error('Invalid token')
    })
  )

  const res1 = await verifyGoogleIdToken('valid-id-token')
  assert(res1 !== null, 'Valid token returns verified object')
  assert(res1?.sub === 'google-sub-unit-001', 'sub mapped correctly')
  assert(res1?.email === 'unit.test@example.com', 'email lowercased correctly')
  assert(res1?.name === 'Unit Tester', 'name mapped correctly')
  assert(res1?.avatar === 'https://lh3.googleusercontent.com/avatar.jpg', 'avatar mapped correctly')
  assert(res1?.emailVerified === true, 'emailVerified is true')

  // 1b. accounts.google.com without https prefix is also valid
  __setGoogleOAuthClientForTest(
    createMockOAuth2Client(async () => ({
      getPayload: () => ({ ...validPayload, iss: 'accounts.google.com' }),
    }))
  )
  const resIss = await verifyGoogleIdToken('valid-id-token')
  assert(resIss !== null, 'accounts.google.com issuer is accepted')

  // 1c. Invalid issuer rejected
  __setGoogleOAuthClientForTest(
    createMockOAuth2Client(async () => ({
      getPayload: () => ({ ...validPayload, iss: 'https://attacker.com' }),
    }))
  )
  const resBadIss = await verifyGoogleIdToken('valid-id-token')
  assert(resBadIss === null, 'Invalid issuer rejected (returned null)')

  // 1d. Audience mismatch rejected
  __setGoogleOAuthClientForTest(
    createMockOAuth2Client(async () => ({
      getPayload: () => ({ ...validPayload, aud: 'wrong-audience.apps.googleusercontent.com' }),
    }))
  )
  const resBadAud = await verifyGoogleIdToken('valid-id-token')
  assert(resBadAud === null, 'Mismatched audience rejected (returned null)')

  // 1e. Expired token rejected
  __setGoogleOAuthClientForTest(
    createMockOAuth2Client(async () => ({
      getPayload: () => ({ ...validPayload, exp: nowSec - 10 }),
    }))
  )
  const resExpired = await verifyGoogleIdToken('valid-id-token')
  assert(resExpired === null, 'Expired token rejected (returned null)')

  // 1f. Missing sub rejected
  __setGoogleOAuthClientForTest(
    createMockOAuth2Client(async () => ({
      getPayload: () => ({ ...validPayload, sub: '' }),
    }))
  )
  const resNoSub = await verifyGoogleIdToken('valid-id-token')
  assert(resNoSub === null, 'Empty sub rejected (returned null)')

  // 1g. Missing email rejected
  __setGoogleOAuthClientForTest(
    createMockOAuth2Client(async () => ({
      getPayload: () => ({ ...validPayload, email: '' }),
    }))
  )
  const resNoEmail = await verifyGoogleIdToken('valid-id-token')
  assert(resNoEmail === null, 'Empty email rejected (returned null)')

  // 1h. Invalid email format rejected
  __setGoogleOAuthClientForTest(
    createMockOAuth2Client(async () => ({
      getPayload: () => ({ ...validPayload, email: 'not-an-email' }),
    }))
  )
  const resBadEmail = await verifyGoogleIdToken('valid-id-token')
  assert(resBadEmail === null, 'Malformed email rejected (returned null)')

  // 1i. email_verified === false rejected
  __setGoogleOAuthClientForTest(
    createMockOAuth2Client(async () => ({
      getPayload: () => ({ ...validPayload, email_verified: false }),
    }))
  )
  const resUnverified = await verifyGoogleIdToken('valid-id-token')
  assert(resUnverified === null, 'email_verified = false rejected (returned null)')

  // 1j. Non-string idToken rejected
  const resNonString = await verifyGoogleIdToken({ sub: '123' })
  assert(resNonString === null, 'Object passed as idToken rejected (returned null)')

  // 1k. Empty/blank idToken rejected
  const resBlank = await verifyGoogleIdToken('   ')
  assert(resBlank === null, 'Blank string idToken rejected (returned null)')

  // 1l. verifyIdToken throwing error handled safely (fail-closed)
  __setGoogleOAuthClientForTest(
    createMockOAuth2Client(async () => {
      throw new Error('Cryptographic signature verification failed')
    })
  )
  const resThrows = await verifyGoogleIdToken('bad-sig-token')
  assert(resThrows === null, 'Threw error in verifyIdToken returns null safely')
}

// -------------------------------------------------------------
// SECTION 2: HTTP Route Security & Rejection Tests (POST /api/v1/auth/google)
// -------------------------------------------------------------
console.log('\n--- 2. Route Security: Rejection of Fake Payloads & Malformed Requests ---')
{
  __resetAuthRateLimitsForTests()

  // 2a. Rejection of raw object with email and googleId (prevent bypass)
  const rawObjRes = await post('/google', {
    email: 'hacker@example.com',
    googleId: 'fake-sub-999',
    sub: 'fake-sub-999',
  })
  assert(rawObjRes.status === 400 || rawObjRes.status === 401, `Raw fake object without credential rejected with 400/401 (got ${rawObjRes.status})`)

  // 2b. Rejection of credential as an object instead of string
  const objCredRes = await post('/google', {
    credential: {
      email: 'hacker@example.com',
      sub: 'fake-sub-999',
    },
  })
  assert(objCredRes.status === 400 || objCredRes.status === 401, `Object credential rejected with 400/401 (got ${objCredRes.status})`)

  // 2c. Rejection of fake unverified JWT string
  __setGoogleOAuthClientForTest(
    createMockOAuth2Client(async () => {
      throw new Error('Bad JWT signature')
    })
  )
  const fakeJwtRes = await post('/google', {
    credential: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiZW1haWwiOiJqb2huQGV4YW1wbGUuY29tIiwiZW1haWxfdmVyaWZpZWQiOnRydWV9.fakesignature',
  })
  assert(fakeJwtRes.status === 401, `Fake JWT string rejected with 401 (got ${fakeJwtRes.status})`)
  const fakeJwtBody = await fakeJwtRes.json()
  assert(fakeJwtBody.code === 'INVALID_GOOGLE_TOKEN' || fakeJwtBody.error?.code === 'INVALID_GOOGLE_TOKEN', 'Error code is INVALID_GOOGLE_TOKEN')

  // 2d. Missing credential field
  const emptyRes = await post('/google', {})
  assert(emptyRes.status === 400, `Empty body returns 400 (got ${emptyRes.status})`)

  // 2e. Rejection when email is not verified
  __setGoogleOAuthClientForTest(
    createMockOAuth2Client(async () => ({
      getPayload: () => ({
        iss: 'https://accounts.google.com',
        aud: config.googleClientId,
        sub: 'sub-unverified-1',
        email: 'unverified@example.com',
        email_verified: false,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    }))
  )
  const unverifiedRes = await post('/google', { credential: 'unverified-token' })
  assert(unverifiedRes.status === 401, `Unverified email rejected with 401 (got ${unverifiedRes.status})`)
}

// -------------------------------------------------------------
// SECTION 3: Valid Google Login, Account Creation & Session Cookies
// -------------------------------------------------------------
console.log('\n--- 3. Valid Google Login & User Lifecycle ---')
{
  __resetAuthRateLimitsForTests()

  const validProfile = {
    iss: 'https://accounts.google.com',
    aud: config.googleClientId,
    sub: 'google-sub-brand-new-1',
    email: 'brandnew.user@example.com',
    name: 'Brand New User',
    picture: 'https://lh3.googleusercontent.com/avatar_new.jpg',
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }

  __setGoogleOAuthClientForTest(
    createMockOAuth2Client(async ({ idToken }) => {
      if (idToken === 'token-brand-new-user') {
        return { getPayload: () => ({ ...validProfile }) }
      }
      throw new Error('Unknown token')
    })
  )

  // 3a. New user registration via Google Sign-In
  const resNew = await post('/google', { credential: 'token-brand-new-user' })
  const bodyNew = await resNew.json()

  assert(resNew.status === 200, `First-time Google login returns 200 (got ${resNew.status})`)
  assert(!!bodyNew.accessToken, 'Returns JWT accessToken')
  assert(bodyNew.user?.email === 'brandnew.user@example.com', 'User email matches')
  assert(bodyNew.user?.name === 'Brand New User', 'User name matches')
  assert(bodyNew.user?.avatar === 'https://lh3.googleusercontent.com/avatar_new.jpg', 'User avatar matches')
  assert(bodyNew.user?.email_verified === true, 'User email_verified is true')
  assert(bodyNew.user?.role === 'user', 'User role is user')
  assert(bodyNew.refreshToken === undefined, 'Does not leak refreshToken in body')
  assert(bodyNew.user?.credits === undefined, 'Does not expose legacy credits')

  // Check HttpOnly Cookie
  const cookieHeader = resNew.headers.get('set-cookie') || ''
  assert(cookieHeader.includes('refresh_token='), 'Set-Cookie contains refresh_token')
  assert(cookieHeader.toLowerCase().includes('httponly'), 'Cookie has HttpOnly flag')
  assert(cookieHeader.toLowerCase().includes('samesite=lax'), 'Cookie has SameSite=lax flag')
  assert(cookieHeader.includes('Path=/api/v1/auth'), 'Cookie Path is /api/v1/auth')

  // Verify in Database
  const dbUser = await queryOne('SELECT * FROM users WHERE google_id = ?', ['google-sub-brand-new-1'])
  assert(!!dbUser, 'User recorded in DB with correct google_id')
  if (dbUser) {
    assert(dbUser.email === 'brandnew.user@example.com', 'DB user email matches')
    assert(Boolean(dbUser.email_verified) === true, 'DB user email_verified is true')
  }

  // 3b. Subsequent login with existing Google account
  const resExisting = await post('/google', { credential: 'token-brand-new-user' })
  const bodyExisting = await resExisting.json()
  assert(resExisting.status === 200, 'Subsequent login returns 200')
  if (dbUser) {
    assert(bodyExisting.user?.id === dbUser.id, 'Returns existing user ID without duplicate')
  }

  const countRows = await query('SELECT id FROM users WHERE email = ?', ['brandnew.user@example.com'])
  assert(countRows.length === 1, 'Exactly 1 row exists in DB for this email')
}

// -------------------------------------------------------------
// SECTION 4: Account Linkage (Existing local user links Google account)
// -------------------------------------------------------------
console.log('\n--- 4. Account Linkage & Takeover Prevention ---')
{
  __resetAuthRateLimitsForTests()

  const localEmail = 'local.unverified@example.com'
  const bcrypt = (await import('bcryptjs')).default
  const hashedPass = await bcrypt.hash('secretPass123!', 10)

  // Tạo tài khoản thường chưa verify
  const localUser = await insert('users', {
    id: 'user-local-link-101',
    email: localEmail,
    password: hashedPass,
    role: 'user',
    name: 'Local Person',
    email_verified: false,
    google_id: null,
  })

  __setGoogleOAuthClientForTest(
    createMockOAuth2Client(async ({ idToken }) => {
      if (idToken === 'token-link-account') {
        return {
          getPayload: () => ({
            iss: 'https://accounts.google.com',
            aud: config.googleClientId,
            sub: 'google-sub-link-8888',
            email: localEmail,
            name: 'Local Person Updated',
            picture: 'https://lh3.googleusercontent.com/avatar_link.jpg',
            email_verified: true,
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        }
      }
      throw new Error('Unknown token')
    })
  )

  const resLink = await post('/google', { credential: 'token-link-account' })
  const bodyLink = await resLink.json()

  assert(resLink.status === 200, `Account linkage returns 200 (got ${resLink.status})`)
  assert(bodyLink.user?.id === 'user-local-link-101', 'Linked to original user ID')
  assert(bodyLink.user?.email_verified === true, 'email_verified promoted to true')

  const updatedDbUser = await queryOne('SELECT * FROM users WHERE id = ?', ['user-local-link-101'])
  assert(!!updatedDbUser, 'User found in DB')
  if (updatedDbUser) {
    assert(updatedDbUser.google_id === 'google-sub-link-8888', 'DB user now has google_id attached')
    assert(Boolean(updatedDbUser.email_verified) === true, 'DB user email_verified updated to true')
    assert(updatedDbUser.password === hashedPass, 'Local password remains intact')
  }
}

// -------------------------------------------------------------
// SECTION 5: Concurrent Requests Race Condition Handling
// -------------------------------------------------------------
console.log('\n--- 5. Concurrency: Multiple simultaneous Google Logins ---')
{
  __resetAuthRateLimitsForTests()

  const concurrentEmail = 'concurrent.user@example.com'
  const concurrentSub = 'google-sub-concurrent-999'

  __setGoogleOAuthClientForTest(
    createMockOAuth2Client(async () => ({
      getPayload: () => ({
        iss: 'https://accounts.google.com',
        aud: config.googleClientId,
        sub: concurrentSub,
        email: concurrentEmail,
        name: 'Concurrent User',
        picture: 'https://lh3.googleusercontent.com/avatar_conc.jpg',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    }))
  )

  // Bắn 5 request đồng thời đăng nhập Google cho user mới chưa có trong DB
  const requests = Array.from({ length: 5 }, () =>
    post('/google', { credential: 'token-concurrent-req' })
  )

  const results = await Promise.all(requests)
  const allStatus200 = results.every((r) => r.status === 200)
  assert(allStatus200, 'Tất cả 5 request đồng thời đều thành công trả về 200')

  const dbRows = await query('SELECT * FROM users WHERE google_id = ?', [concurrentSub])
  assert(dbRows.length === 1, `Không bị nhân bản tài khoản (got ${dbRows.length} row)`)

  const bodies = await Promise.all(results.map((r) => r.json()))
  const ids = new Set(bodies.map((b) => b.user?.id))
  assert(ids.size === 1, 'Tất cả 5 response đều trả về cùng một user ID duy nhất')
}

__resetGoogleOAuthClientForTest()
server.close()

if (failures > 0) {
  console.error(`\nFAILED: ${failures} assertions failed`)
  process.exit(1)
} else {
  console.log('\nALL PASS: Google ID Token Authentication Security & Unit tests validated successfully.')
  process.exit(0)
}
