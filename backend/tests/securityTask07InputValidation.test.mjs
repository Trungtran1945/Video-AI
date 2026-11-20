// Security Hardening TASK-07: Input Validation & Sanitization Test Suite
// Run: node backend/tests/securityTask07InputValidation.test.mjs
import {
  validate,
  validateBody,
  validateParams,
  validateQuery,
} from '../src/middleware/validate.js'
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyOtpSchema,
  createProjectSchema,
  updateProjectSchema,
  settingsSchema,
  apiKeySchema,
  idParamSchema,
  idSchema,
} from '../src/validation/schemas.js'

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log('PASS:', msg)
  } else {
    failures++
    console.error('FAIL:', msg)
  }
}

function mockRes() {
  return {
    statusCode: null,
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

console.log('=== TASK 7: Input Validation & Schema Sanitization Test Suite ===\n')

// 1. Auth Schemas Validation
console.log('--- 1. Auth Schemas Validation ---')
{
  // 1.1 Register: Missing fields -> 400
  {
    const req = { body: {} }
    const res = mockRes()
    let nextCalled = false
    validateBody(registerSchema)(req, res, () => { nextCalled = true })
    assert(!nextCalled && res.statusCode === 400, 'empty register body rejected with 400')
    assert(res.body?.code === 'INVALID_INPUT', `error code is INVALID_INPUT (got ${res.body?.code})`)
  }

  // 1.2 Register: Invalid email -> 400
  {
    const req = { body: { email: 'not-an-email', password: 'Password123!' } }
    const res = mockRes()
    let nextCalled = false
    validateBody(registerSchema)(req, res, () => { nextCalled = true })
    assert(!nextCalled && res.statusCode === 400, 'malformed email rejected with 400')
    assert(res.body?.field === 'email', 'error identifies email field')
  }

  // 1.3 Register: Password too short (< 8 chars) -> 400
  {
    const req = { body: { email: 'user@example.com', password: '123' } }
    const res = mockRes()
    let nextCalled = false
    validateBody(registerSchema)(req, res, () => { nextCalled = true })
    assert(!nextCalled && res.statusCode === 400, 'short password (<8 chars) rejected with 400')
    assert(res.body?.field === 'password', 'error identifies password field')
  }

  // 1.4 Register: Password exceeds 72 bytes (BCrypt limit DoS vector) -> 400
  {
    const req = { body: { email: 'user@example.com', password: 'A'.repeat(80) } }
    const res = mockRes()
    let nextCalled = false
    validateBody(registerSchema)(req, res, () => { nextCalled = true })
    assert(!nextCalled && res.statusCode === 400, 'overlong password (>72 bytes) rejected with 400')
  }

  // 1.5 Register: Valid input passes & normalizes email to lowercase + trimmed
  {
    const req = { body: { email: '  User.Test@Example.COM  ', password: 'ValidPassword123!', name: ' Alice ' } }
    const res = mockRes()
    let nextCalled = false
    validateBody(registerSchema)(req, res, () => { nextCalled = true })
    assert(nextCalled, 'valid register input invokes next()')
    assert(req.body.email === 'user.test@example.com', `email sanitized & lowercased (got ${req.body.email})`)
    assert(req.body.name === 'Alice', `name trimmed (got ${req.body.name})`)
  }

  // 1.6 Login: Missing password -> 400
  {
    const req = { body: { email: 'user@example.com' } }
    const res = mockRes()
    let nextCalled = false
    validateBody(loginSchema)(req, res, () => { nextCalled = true })
    assert(!nextCalled && res.statusCode === 400, 'missing password in login rejected with 400')
  }

  // 1.7 Reset Password: Valid token + password or newPassword
  {
    const req = { body: { token: 'valid-reset-token-abc', password: 'NewSecurePassword123!' } }
    const res = mockRes()
    let nextCalled = false
    validateBody(resetPasswordSchema)(req, res, () => { nextCalled = true })
    assert(nextCalled, 'valid reset-password body with password accepted')

    const reqNewPass = { body: { token: 'valid-reset-token-abc', newPassword: 'NewSecurePassword123!' } }
    let nextNewPass = false
    validateBody(resetPasswordSchema)(reqNewPass, mockRes(), () => { nextNewPass = true })
    assert(nextNewPass, 'valid reset-password body with newPassword accepted')
  }

  // 1.8 OTP Validation: Must be 6 digits
  {
    const reqBad = { body: { email: 'user@example.com', otp: '123' } }
    const resBad = mockRes()
    let nextBad = false
    validateBody(verifyOtpSchema)(reqBad, resBad, () => { nextBad = true })
    assert(!nextBad && resBad.statusCode === 400, 'non-6-digit OTP rejected with 400')

    const reqGood = { body: { email: 'user@example.com', otp: '123456' } }
    let nextGood = false
    validateBody(verifyOtpSchema)(reqGood, mockRes(), () => { nextGood = true })
    assert(nextGood, 'valid 6-digit OTP accepted')
  }
}

// 2. Project Schemas Validation
console.log('\n--- 2. Project Schemas Validation ---')
{
  // 2.1 Create Project: Empty title -> 400
  {
    const req = { body: { title: '   ', mode: 'TRANSLATE_DUB' } }
    const res = mockRes()
    let nextCalled = false
    validateBody(createProjectSchema)(req, res, () => { nextCalled = true })
    assert(!nextCalled && res.statusCode === 400, 'whitespace-only project title rejected with 400')
  }

  // 2.2 Create Project: Overlong title (> 255 chars) -> 400
  {
    const req = { body: { title: 'T'.repeat(256), mode: 'TRANSLATE_DUB' } }
    const res = mockRes()
    let nextCalled = false
    validateBody(createProjectSchema)(req, res, () => { nextCalled = true })
    assert(!nextCalled && res.statusCode === 400, 'title > 255 characters rejected with 400')
  }

  // 2.3 Create Project: Invalid mode enum -> 400
  {
    const req = { body: { title: 'Valid Title', mode: 'INVALID_UNKNOWN_MODE' } }
    const res = mockRes()
    let nextCalled = false
    validateBody(createProjectSchema)(req, res, () => { nextCalled = true })
    assert(!nextCalled && res.statusCode === 400, 'unsupported mode enum rejected with 400')
    assert(
      res.body?.message?.includes('SUMMARY') || res.body?.message?.includes('expected one of'),
      `returns helpful enum error message (got: ${res.body?.message})`
    )
  }

  // 2.4 Create Project: Valid modes pass
  {
    for (const mode of ['SUMMARY', 'TRANSLATE_DUB', 'SCRIPT_TO_VIDEO', 'MEDIA_COMPOSER', 'AI_VIDEO']) {
      const req = { body: { title: `My Project ${mode}`, mode } }
      let nextCalled = false
      validateBody(createProjectSchema)(req, mockRes(), () => { nextCalled = true })
      assert(nextCalled, `valid mode '${mode}' accepted`)
    }
  }

  // 2.5 Create Project: Passthrough preserves additional properties
  {
    const req = {
      body: {
        title: 'Composer Project',
        mode: 'MEDIA_COMPOSER',
        copyrightAcknowledged: true,
        sourceVideoKey: 'source/video/123.mp4',
        params: { resolution: '1080p', fps: 30 },
      },
    }
    let nextCalled = false
    validateBody(createProjectSchema)(req, mockRes(), () => { nextCalled = true })
    assert(nextCalled, 'createProjectSchema with extra params accepted')
    assert(req.body.copyrightAcknowledged === true, 'copyrightAcknowledged preserved via passthrough')
    assert(req.body.sourceVideoKey === 'source/video/123.mp4', 'sourceVideoKey preserved via passthrough')
    assert(req.body.params?.resolution === '1080p', 'params object preserved via passthrough')
  }
}

// 3. Settings Schemas Validation
console.log('\n--- 3. Settings Schemas Validation ---')
{
  // 3.1 Invalid aspect_ratio -> 400
  {
    const req = { body: { aspect_ratio: '3:2' } }
    const res = mockRes()
    let nextCalled = false
    validateBody(settingsSchema)(req, res, () => { nextCalled = true })
    assert(!nextCalled && res.statusCode === 400, 'invalid aspect_ratio enum rejected with 400')
  }

  // 3.2 Out-of-bounds volume (< 0 or > 100) -> 400
  {
    const reqNegative = { body: { volume: -5 } }
    const resNeg = mockRes()
    let nextNeg = false
    validateBody(settingsSchema)(reqNegative, resNeg, () => { nextNeg = true })
    assert(!nextNeg && resNeg.statusCode === 400, 'negative volume rejected with 400')

    const reqOver = { body: { volume: 150 } }
    const resOver = mockRes()
    let nextOver = false
    validateBody(settingsSchema)(reqOver, resOver, () => { nextOver = true })
    assert(!nextOver && resOver.statusCode === 400, 'volume > 100 rejected with 400')
  }

  // 3.3 Out-of-bounds speed (< 0.25 or > 4.0) -> 400
  {
    const reqSpeed = { body: { speed: 5.5 } }
    const resSpeed = mockRes()
    let nextSpeed = false
    validateBody(settingsSchema)(reqSpeed, resSpeed, () => { nextSpeed = true })
    assert(!nextSpeed && resSpeed.statusCode === 400, 'playback speed > 4.0 rejected with 400')
  }

  // 3.4 Valid settings pass
  {
    const req = { body: { aspect_ratio: '16:9', volume: 80, speed: 1.25, theme: 'dark' } }
    let nextCalled = false
    validateBody(settingsSchema)(req, mockRes(), () => { nextCalled = true })
    assert(nextCalled, 'valid settings body accepted')
  }
}

// 4. API Keys Schemas Validation
console.log('\n--- 4. API Keys Schemas Validation ---')
{
  // 4.1 Unsupported provider -> 400
  {
    const req = { body: { provider: 'unknown_ai_vendor', key: 'sk-123456' } }
    const res = mockRes()
    let nextCalled = false
    validateBody(apiKeySchema)(req, res, () => { nextCalled = true })
    assert(!nextCalled && res.statusCode === 400, 'unknown AI provider rejected with 400')
  }

  // 4.2 Empty key -> 400
  {
    const req = { body: { provider: 'gemini', key: '   ' } }
    const res = mockRes()
    let nextCalled = false
    validateBody(apiKeySchema)(req, res, () => { nextCalled = true })
    assert(!nextCalled && res.statusCode === 400, 'empty API key rejected with 400')
  }

  // 4.3 Negative priority -> 400
  {
    const req = { body: { provider: 'gemini', key: 'sk-valid', priority: -1 } }
    const res = mockRes()
    let nextCalled = false
    validateBody(apiKeySchema)(req, res, () => { nextCalled = true })
    assert(!nextCalled && res.statusCode === 400, 'negative priority rejected with 400')
  }

  // 4.4 Valid API key passes
  {
    const req = { body: { provider: 'openai', key: 'sk-proj-valid-openai-key', priority: 5, label: 'prod' } }
    let nextCalled = false
    validateBody(apiKeySchema)(req, mockRes(), () => { nextCalled = true })
    assert(nextCalled, 'valid API key accepted')
  }
}

// 5. Route Parameter Validation
console.log('\n--- 5. Route Parameter Validation ---')
{
  // 5.1 Invalid route param containing illegal characters (e.g. path traversal / injection) -> 400
  {
    const req = { params: { id: '../../etc/passwd' } }
    const res = mockRes()
    let nextCalled = false
    validateParams(idParamSchema)(req, res, () => { nextCalled = true })
    assert(!nextCalled && res.statusCode === 400, 'path traversal ID parameter rejected with 400')
  }

  // 5.2 Empty route param -> 400
  {
    const req = { params: { id: '' } }
    const res = mockRes()
    let nextCalled = false
    validateParams(idParamSchema)(req, res, () => { nextCalled = true })
    assert(!nextCalled && res.statusCode === 400, 'empty ID parameter rejected with 400')
  }

  // 5.3 Valid UUID / alphanumeric ID passes
  {
    const req = { params: { id: 'proj_2026-abc_123' } }
    let nextCalled = false
    validateParams(idParamSchema)(req, mockRes(), () => { nextCalled = true })
    assert(nextCalled, 'valid alphanumeric route param ID accepted')
  }
}

// 6. Multi-target Validation (body + params + query simultaneously)
console.log('\n--- 6. Combined Multi-Target Validation ---')
{
  const validator = validate({
    params: idParamSchema,
    body: updateProjectSchema,
  })

  // Invalid params fails immediately
  const reqBadParam = { params: { id: 'invalid!char' }, body: { title: 'Valid' } }
  const resBadParam = mockRes()
  let nextBadParam = false
  validator(reqBadParam, resBadParam, () => { nextBadParam = true })
  assert(!nextBadParam && resBadParam.statusCode === 400, 'combined validation catches param failure')

  // Invalid body fails
  const reqBadBody = { params: { id: 'valid_id' }, body: { title: 'T'.repeat(300) } }
  const resBadBody = mockRes()
  let nextBadBody = false
  validator(reqBadBody, resBadBody, () => { nextBadBody = true })
  assert(!nextBadBody && resBadBody.statusCode === 400, 'combined validation catches body failure')

  // Both valid passes
  const reqGood = { params: { id: 'valid_id' }, body: { title: 'Good Title' } }
  let nextGood = false
  validator(reqGood, mockRes(), () => { nextGood = true })
  assert(nextGood, 'combined validation passes when both targets are valid')
}

console.log(failures === 0 ? '\nALL TASK 7 TESTS PASS' : `\n${failures} FAILURES IN TASK 7`)
process.exit(failures === 0 ? 0 : 1)
