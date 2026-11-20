import assert from 'node:assert'
import express from 'express'
import { once } from 'node:events'
import { v4 as uuidv4 } from 'uuid'
import {
  SENSITIVE_RESPONSE_FIELDS,
  isSensitiveKey,
  sanitizeStringContent,
  sanitizeResponseDto,
  sanitizeUserDto,
  sanitizeApiKeyDto,
  responseSanitizerMiddleware,
} from '../src/lib/responseSanitizer.js'
import { sendError } from '../src/lib/httpError.js'

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
    console.error(`FAIL: ${name} ->`, err)
  }
}

async function run() {
  console.log('\n--- SECTION 1: Sensitive Field Recognition & Key Filtering ---')

  test('isSensitiveKey detects password and hash variants', () => {
    assert.strictEqual(isSensitiveKey('password'), true)
    assert.strictEqual(isSensitiveKey('password_hash'), true)
    assert.strictEqual(isSensitiveKey('passwordHash'), true)
    assert.strictEqual(isSensitiveKey('salt'), true)
    assert.strictEqual(isSensitiveKey('user_password'), true)
  })

  test('isSensitiveKey detects session, refresh and reset tokens', () => {
    assert.strictEqual(isSensitiveKey('refresh_token'), true)
    assert.strictEqual(isSensitiveKey('refreshToken'), true)
    assert.strictEqual(isSensitiveKey('reset_token'), true)
    assert.strictEqual(isSensitiveKey('resetToken'), true)
    assert.strictEqual(isSensitiveKey('reset_token_hash'), true)
    assert.strictEqual(isSensitiveKey('verification_token'), true)
  })

  test('isSensitiveKey detects encryption keys and secrets', () => {
    assert.strictEqual(isSensitiveKey('encrypted_key'), true)
    assert.strictEqual(isSensitiveKey('encryptedKey'), true)
    assert.strictEqual(isSensitiveKey('master_key'), true)
    assert.strictEqual(isSensitiveKey('secret_key'), true)
    assert.strictEqual(isSensitiveKey('api_key_secret'), true)
    assert.strictEqual(isSensitiveKey('token_secret'), true)
  })

  test('isSensitiveKey detects diagnostics and error stacks', () => {
    assert.strictEqual(isSensitiveKey('stack'), true)
    assert.strictEqual(isSensitiveKey('stacktrace'), true)
    assert.strictEqual(isSensitiveKey('database_url'), true)
    assert.strictEqual(isSensitiveKey('query_text'), true)
  })

  test('isSensitiveKey permits legitimate public attributes', () => {
    assert.strictEqual(isSensitiveKey('id'), false)
    assert.strictEqual(isSensitiveKey('email'), false)
    assert.strictEqual(isSensitiveKey('name'), false)
    assert.strictEqual(isSensitiveKey('role'), false)
    assert.strictEqual(isSensitiveKey('created_date'), false)
    assert.strictEqual(isSensitiveKey('title'), false)
    assert.strictEqual(isSensitiveKey('key_prefix'), false)
  })

  console.log('\n--- SECTION 2: String Sanitization (Internal Paths & Connection URIs) ---')

  test('sanitizeStringContent redacts database connection strings', () => {
    const raw = 'Connected to postgresql://postgres:super_secret_pw@db.internal:5432/video_ai'
    const cleaned = sanitizeStringContent(raw)
    assert.ok(!cleaned.includes('super_secret_pw'))
    assert.ok(cleaned.includes('postgresql://[redacted]@db.internal:5432/video_ai'))
  })

  test('sanitizeStringContent redacts Windows absolute server paths', () => {
    const raw = 'File not found at D:\\E\\Video_AI\\backend\\storage\\keys\\master.key on worker node'
    const cleaned = sanitizeStringContent(raw)
    assert.ok(!cleaned.includes('D:\\E\\Video_AI'))
    assert.ok(cleaned.includes('[internal path]'))
  })

  test('sanitizeStringContent redacts Unix absolute server paths', () => {
    const raw = 'Permission denied reading /var/www/app/backend/.env'
    const cleaned = sanitizeStringContent(raw)
    assert.ok(!cleaned.includes('/var/www/app'))
    assert.ok(cleaned.includes('[internal path]'))
  })

  test('sanitizeStringContent preserves relative paths and safe URLs', () => {
    assert.strictEqual(sanitizeStringContent('/api/v1/projects'), '/api/v1/projects')
    assert.strictEqual(sanitizeStringContent('/storage/uploads/sample.mp4'), '/storage/uploads/sample.mp4')
    assert.strictEqual(sanitizeStringContent('uploads/image.png'), 'uploads/image.png')
  })

  console.log('\n--- SECTION 3: Deep Recursive DTO Sanitization (sanitizeResponseDto) ---')

  test('sanitizeResponseDto recursively strips sensitive fields from deeply nested objects', () => {
    const payload = {
      status: 'success',
      data: {
        user: {
          id: 'user-123',
          email: 'user@example.com',
          password_hash: '$2b$10$abcdef1234567890',
          refresh_token: 'raw-refresh-token-secret',
          profile: {
            name: 'Alice',
            salt: 'secret-salt-xyz',
          },
        },
        api_keys: [
          {
            id: 'key-1',
            provider: 'openai',
            encrypted_key: 'v1:aes-encrypted-data',
            master_key: 'master-key-value',
            label: 'Production Key',
          },
        ],
        diagnostics: {
          database_url: 'postgresql://user:pass@host/db',
          stack: 'Error: boom\n    at Object.<anonymous>',
        },
      },
    }

    const cleaned = sanitizeResponseDto(payload)

    // Verify sensitive fields are completely omitted
    assert.strictEqual(cleaned.status, 'success')
    assert.strictEqual(cleaned.data.user.id, 'user-123')
    assert.strictEqual(cleaned.data.user.email, 'user@example.com')
    assert.strictEqual(cleaned.data.user.profile.name, 'Alice')
    assert.strictEqual(cleaned.data.user.password_hash, undefined)
    assert.strictEqual(cleaned.data.user.refresh_token, undefined)
    assert.strictEqual(cleaned.data.user.profile.salt, undefined)

    assert.strictEqual(cleaned.data.api_keys.length, 1)
    assert.strictEqual(cleaned.data.api_keys[0].id, 'key-1')
    assert.strictEqual(cleaned.data.api_keys[0].label, 'Production Key')
    assert.strictEqual(cleaned.data.api_keys[0].encrypted_key, undefined)
    assert.strictEqual(cleaned.data.api_keys[0].master_key, undefined)

    assert.strictEqual(cleaned.data.diagnostics.database_url, undefined)
    assert.strictEqual(cleaned.data.diagnostics.stack, undefined)
  })

  test('sanitizeResponseDto preserves primitives, Dates, Buffers, arrays', () => {
    const date = new Date()
    const buf = Buffer.from('hello')
    const input = {
      timestamp: date,
      buffer: buf,
      count: 42,
      active: true,
      nothing: null,
      tags: ['a', 'b', 'c'],
    }

    const cleaned = sanitizeResponseDto(input)
    assert.strictEqual(cleaned.timestamp, date)
    assert.strictEqual(cleaned.buffer, buf)
    assert.strictEqual(cleaned.count, 42)
    assert.strictEqual(cleaned.active, true)
    assert.strictEqual(cleaned.nothing, null)
    assert.deepStrictEqual(cleaned.tags, ['a', 'b', 'c'])
  })

  console.log('\n--- SECTION 4: Dedicated DTO Whitelist Sanitizers ---')

  test('sanitizeUserDto strictly whitelists safe fields and purges all credentials', () => {
    const rawUser = {
      id: 'usr-456',
      email: 'bob@example.com',
      password: '$2b$10$hashedpw',
      password_hash: '$2b$10$hashedpw',
      refresh_token: 'secret_hash',
      refresh_expires: '2026-11-20T00:00:00Z',
      role: 'admin',
      name: 'Bob',
      avatar: 'https://example.com/avatar.jpg',
      email_verified: 1,
      otp_attempts: 2,
      created_date: '2026-01-01T00:00:00Z',
    }

    const dto = sanitizeUserDto(rawUser)
    assert.deepStrictEqual(dto, {
      id: 'usr-456',
      email: 'bob@example.com',
      role: 'admin',
      name: 'Bob',
      email_verified: true,
      avatar: 'https://example.com/avatar.jpg',
      created_date: '2026-01-01T00:00:00Z',
    })
    assert.strictEqual(dto.password, undefined)
    assert.strictEqual(dto.password_hash, undefined)
    assert.strictEqual(dto.refresh_token, undefined)
    assert.strictEqual(dto.otp_attempts, undefined)
  })

  test('sanitizeApiKeyDto never exposes raw or encrypted secrets', () => {
    const rawKey = {
      id: 'key-789',
      user_id: 'usr-456',
      provider: 'gemini',
      label: 'Gemini Pro',
      encrypted_key: 'v1:deadbeef1234',
      key: 'secret-raw-key',
      key_prefix: 'AIzaSy***',
      preview: 'AIzaSy***',
      tier: 'standard',
      priority: 10,
      is_active: 1,
      created_date: '2026-02-01T00:00:00Z',
      last_used_date: '2026-02-15T00:00:00Z',
    }

    const dto = sanitizeApiKeyDto(rawKey)
    assert.strictEqual(dto.id, 'key-789')
    assert.strictEqual(dto.provider, 'gemini')
    assert.strictEqual(dto.key_prefix, 'AIzaSy***')
    assert.strictEqual(dto.is_active, true)
    assert.strictEqual(dto.encrypted_key, undefined)
    assert.strictEqual(dto.key, undefined)
  })

  console.log('\n--- SECTION 5: HTTP Error Sanitization & Error ID Tracing (sendError) ---')

  await asyncTest('sendError attaches unique errorId on 5xx errors and sanitizes stack in extra', async () => {
    const app = express()
    app.get('/test-500', (req, res) => {
      sendError(res, 500, 'INTERNAL_ERROR', 'Unexpected database failure', {
        stack: 'Error at Query.run (/var/www/backend/src/db/query.js:123)',
        database_url: 'postgresql://user:pass@localhost:5432/db',
        safeContext: 'retry_later',
      })
    })

    const server = app.listen(0)
    await once(server, 'listening')
    const { port } = server.address()

    try {
      const res = await fetch(`http://127.0.0.1:${port}/test-500`)
      assert.strictEqual(res.status, 500)
      const body = await res.json()

      assert.strictEqual(body.code, 'INTERNAL_ERROR')
      assert.ok(typeof body.errorId === 'string' && body.errorId.length === 36, 'Returns UUID errorId')
      assert.strictEqual(body.error.errorId, body.errorId)
      assert.strictEqual(body.stack, undefined, 'Stack trace is purged')
      assert.strictEqual(body.database_url, undefined, 'Database URL is purged')
      assert.strictEqual(body.safeContext, 'retry_later', 'Safe context is preserved')
    } finally {
      server.close()
    }
  })

  await asyncTest('sendError in production masks detailed 500 messages with generic error', async () => {
    const originalEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'

    const app = express()
    app.get('/test-500-prod', (req, res) => {
      sendError(res, 500, 'INTERNAL_ERROR', 'Sensitive table users column password corrupted at D:\\db.sqlite')
    })

    const server = app.listen(0)
    await once(server, 'listening')
    const { port } = server.address()

    try {
      const res = await fetch(`http://127.0.0.1:${port}/test-500-prod`)
      assert.strictEqual(res.status, 500)
      const body = await res.json()

      assert.strictEqual(body.message, 'Internal server error', 'Message is masked in production')
      assert.strictEqual(body.error.message, 'Internal server error')
      assert.ok(typeof body.errorId === 'string')
    } finally {
      process.env.NODE_ENV = originalEnv
      server.close()
    }
  })

  console.log('\n--- SECTION 6: Express Middleware End-to-End Interception ---')

  await asyncTest('responseSanitizerMiddleware automatically scrubs sensitive data on all res.json()', async () => {
    const app = express()
    app.use(responseSanitizerMiddleware)

    app.get('/api/users/profile', (req, res) => {
      res.json({
        id: 'usr-1',
        email: 'test@example.com',
        password_hash: '$2b$10$verysecretpasswordhash',
        refresh_token: 'secret_jwt_refresh',
        role: 'user',
        details: {
          server_dir: 'D:\\E\\Video_AI\\backend\\logs\\app.log',
          notes: 'Active user',
        },
      })
    })

    const server = app.listen(0)
    await once(server, 'listening')
    const { port } = server.address()

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/users/profile`)
      assert.strictEqual(res.status, 200)
      const body = await res.json()

      assert.strictEqual(body.id, 'usr-1')
      assert.strictEqual(body.email, 'test@example.com')
      assert.strictEqual(body.role, 'user')
      assert.strictEqual(body.password_hash, undefined, 'password_hash automatically stripped')
      assert.strictEqual(body.refresh_token, undefined, 'refresh_token automatically stripped')
      assert.ok(!body.details.server_dir.includes('D:\\E\\Video_AI'), 'Internal server directory redacted')
      assert.strictEqual(body.details.notes, 'Active user')
    } finally {
      server.close()
    }
  })

  await asyncTest('Global error handling masks unhandled route throws into clean JSON', async () => {
    const app = express()
    app.use(responseSanitizerMiddleware)

    app.get('/unhandled-crash', (req, res, next) => {
      const err = new Error('Database connection failed on query SELECT * FROM users WHERE password_hash = 123')
      err.status = 500
      next(err)
    })

    // Express global error handler
    app.use((err, req, res, next) => {
      const status = err.status || 500
      const code = err.code || 'INTERNAL_ERROR'
      return sendError(res, status, code, err.message)
    })

    const server = app.listen(0)
    await once(server, 'listening')
    const { port } = server.address()

    try {
      const res = await fetch(`http://127.0.0.1:${port}/unhandled-crash`)
      assert.strictEqual(res.status, 500)
      const body = await res.json()

      assert.strictEqual(body.code, 'INTERNAL_ERROR')
      assert.ok(typeof body.errorId === 'string', 'Returns traceable errorId')
      assert.strictEqual(body.stack, undefined, 'Stack trace is not sent')
    } finally {
      server.close()
    }
  })

  // Cleanup queues & timers
  try {
    const { connection } = await import('../src/queue/connection.js')
    try { connection.disconnect() } catch (_) {}
    const { projectQueue } = await import('../src/queue/projectQueue.js')
    const { drainQueue } = await import('../src/queue/drainQueue.js')
    const { notifyQueue } = await import('../src/queue/notifyQueue.js')
    const { cleanupQueue } = await import('../src/queue/cleanupQueue.js')
    await Promise.all([projectQueue.close(), drainQueue.close(), notifyQueue.close(), cleanupQueue.close()].map((p) => p.catch(() => {})))
  } catch (_) {}
  await new Promise((r) => setTimeout(r, 200))

  console.log(`\n========================================`)
  if (failures === 0) {
    console.log('ALL SECURITY TASK 17 TESTS PASSED!')
    console.log('========================================\n')
    process.exit(0)
  } else {
    console.error(`TOTAL FAILURES: ${failures}`)
    console.log('========================================\n')
    process.exit(1)
  }
}

run().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
