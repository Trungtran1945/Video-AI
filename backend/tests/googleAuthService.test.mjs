// Unit test suite for googleAuthService.js
// Run: node backend/tests/googleAuthService.test.mjs
process.env.NODE_ENV = 'test'
import {
  verifyGoogleIdToken,
  __setGoogleOAuthClientForTest,
  __resetGoogleOAuthClientForTest,
} from '../src/services/googleAuthService.js'

let failures = 0
const assert = (c, m) => {
  if (c) {
    console.log('PASS:', m)
  } else {
    failures++
    console.error('FAIL:', m)
  }
}

console.log('\n--- Test Suite: googleAuthService unit tests ---')

// 1. Missing or invalid input
{
  const resNull = await verifyGoogleIdToken(null)
  assert(resNull === null, 'verifyGoogleIdToken(null) returns null')

  const resUndefined = await verifyGoogleIdToken(undefined)
  assert(resUndefined === null, 'verifyGoogleIdToken(undefined) returns null')

  const resEmpty = await verifyGoogleIdToken('   ')
  assert(resEmpty === null, 'verifyGoogleIdToken empty string returns null')

  const resObj = await verifyGoogleIdToken({ email: 'test@example.com' })
  assert(resObj === null, 'verifyGoogleIdToken object returns null')
}

// 2. Mock client verification tests
{
  let mockPayload = {}
  let mockShouldThrow = false

  const mockClient = {
    async verifyIdToken() {
      if (mockShouldThrow) {
        throw new Error('Google token signature verification failed')
      }
      return {
        getPayload: () => ({ ...mockPayload }),
      }
    },
  }

  __setGoogleOAuthClientForTest(mockClient)

  // 2a. Valid payload
  mockShouldThrow = false
  mockPayload = {
    iss: 'https://accounts.google.com',
    aud: 'test-aud-123',
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: 'google-sub-12345',
    email: 'valid.user@example.com',
    email_verified: true,
    name: 'Valid User',
    picture: 'https://example.com/avatar.jpg',
  }
  const validRes = await verifyGoogleIdToken('dummy.jwt.token', { audience: 'test-aud-123' })
  assert(validRes !== null, 'Valid token returns profile')
  assert(validRes.sub === 'google-sub-12345', 'sub matches')
  assert(validRes.email === 'valid.user@example.com', 'email matches')
  assert(validRes.name === 'Valid User', 'name matches')
  assert(validRes.avatar === 'https://example.com/avatar.jpg', 'avatar matches')
  assert(validRes.emailVerified === true, 'emailVerified is true')

  // 2b. accounts.google.com without https:// is also valid
  mockPayload.iss = 'accounts.google.com'
  const validIss2 = await verifyGoogleIdToken('dummy.jwt.token', { audience: 'test-aud-123' })
  assert(validIss2 !== null, 'accounts.google.com issuer is valid')

  // 2c. Signature verification throws
  mockShouldThrow = true
  const throwRes = await verifyGoogleIdToken('dummy.jwt.token', { audience: 'test-aud-123' })
  assert(throwRes === null, 'Signature failure returns null')
  mockShouldThrow = false

  // 2d. Wrong issuer
  mockPayload.iss = 'https://fake-google.com'
  const badIssRes = await verifyGoogleIdToken('dummy.jwt.token', { audience: 'test-aud-123' })
  assert(badIssRes === null, 'Wrong issuer returns null')
  mockPayload.iss = 'https://accounts.google.com'

  // 2e. Wrong audience
  mockPayload.aud = 'different-audience'
  const badAudRes = await verifyGoogleIdToken('dummy.jwt.token', { audience: 'test-aud-123' })
  assert(badAudRes === null, 'Mismatched audience returns null')
  mockPayload.aud = 'test-aud-123'

  // 2f. Expired token
  mockPayload.exp = Math.floor(Date.now() / 1000) - 10
  const expRes = await verifyGoogleIdToken('dummy.jwt.token', { audience: 'test-aud-123' })
  assert(expRes === null, 'Expired token returns null')
  mockPayload.exp = Math.floor(Date.now() / 1000) + 3600

  // 2g. Missing sub
  mockPayload.sub = ''
  const noSubRes = await verifyGoogleIdToken('dummy.jwt.token', { audience: 'test-aud-123' })
  assert(noSubRes === null, 'Missing sub returns null')
  mockPayload.sub = 'google-sub-12345'

  // 2h. Missing email
  mockPayload.email = ''
  const noEmailRes = await verifyGoogleIdToken('dummy.jwt.token', { audience: 'test-aud-123' })
  assert(noEmailRes === null, 'Missing email returns null')

  // 2i. Invalid email format
  mockPayload.email = 'not-an-email'
  const badEmailRes = await verifyGoogleIdToken('dummy.jwt.token', { audience: 'test-aud-123' })
  assert(badEmailRes === null, 'Invalid email format returns null')
  mockPayload.email = 'valid.user@example.com'

  // 2j. Unverified email (email_verified === false)
  mockPayload.email_verified = false
  const unverifiedRes = await verifyGoogleIdToken('dummy.jwt.token', { audience: 'test-aud-123' })
  assert(unverifiedRes === null, 'email_verified = false returns null')

  __resetGoogleOAuthClientForTest()
}

// 3. __setGoogleOAuthClientForTest safety in production
{
  const oldNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  let threw = false
  try {
    __setGoogleOAuthClientForTest({})
  } catch (e) {
    threw = true
  }
  assert(threw === true, '__setGoogleOAuthClientForTest throws error outside test environment')
  process.env.NODE_ENV = oldNodeEnv
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} assertions failed`)
  process.exit(1)
} else {
  console.log('\nALL PASS: googleAuthService unit tests passed successfully.')
  process.exit(0)
}
