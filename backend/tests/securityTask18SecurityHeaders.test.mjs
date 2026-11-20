/**
 * TASK 18 Security Hardening Verification Test Suite
 * Comprehensive Security Headers (Helmet & CSP - SEC-11 & OWASP ASVS L2)
 *
 * Verifies:
 * 1. Unit tests for security header builders & sensitive path detection.
 * 2. Baseline ASVS L2 browser protection headers:
 *    - X-Content-Type-Options: nosniff
 *    - X-Frame-Options: SAMEORIGIN
 *    - Referrer-Policy: strict-origin-when-cross-origin
 *    - Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
 *    - Cross-Origin-Opener-Policy: same-origin-allow-popups
 * 3. Server fingerprint elimination: X-Powered-By is stripped/disabled.
 * 4. Content-Security-Policy (CSP) tailored directives (Vite, Google OAuth, Audio/Video media).
 * 5. Tiered Cross-Origin-Resource-Policy (CORP):
 *    - same-origin for API endpoints.
 *    - cross-origin & Access-Control-Allow-Origin: * for /storage/* media files (prevent tainted canvas / Web Audio).
 * 6. Tiered Cache-Control:
 *    - Strict no-store/no-cache on sensitive routes (auth, api-keys, settings, admin).
 *    - Normal streaming / caching on storage and health endpoints.
 */

import assert from 'node:assert/strict'
import express from 'express'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  securityHeadersMiddleware,
  sensitiveNoCache,
  buildCspHeader,
  isSensitivePath,
  DEFAULT_CSP_DIRECTIVES,
  SENSITIVE_PATH_PREFIXES,
} from '../src/middleware/securityHeaders.js'
import { createSafeMediaStatic } from '../src/middleware/safeMediaStatic.js'

let totalAssertions = 0
function test(name, fn) {
  try {
    fn()
    totalAssertions += 1
    console.log(`PASS: ${name}`)
  } catch (err) {
    console.error(`FAIL: ${name}`)
    console.error(err)
    process.exit(1)
  }
}

async function asyncTest(name, fn) {
  try {
    await fn()
    totalAssertions += 1
    console.log(`PASS: ${name}`)
  } catch (err) {
    console.error(`FAIL: ${name}`)
    console.error(err)
    process.exit(1)
  }
}

console.log('=== securityTask18SecurityHeaders.test.mjs ===\n')

// -------------------------------------------------------------
// SECTION 1: Unit Tests for Security Header Helpers
// -------------------------------------------------------------
console.log('--- SECTION 1: Unit Tests for Header Builders & Path Detection ---')

test('buildCspHeader generates valid semicolon-separated CSP string', () => {
  const custom = {
    'default-src': "'self'",
    'object-src': "'none'",
  }
  const csp = buildCspHeader(custom)
  assert.equal(csp, "default-src 'self'; object-src 'none'")
})

test('DEFAULT_CSP_DIRECTIVES contains all required ASVS L2 security directives', () => {
  assert.equal(DEFAULT_CSP_DIRECTIVES['default-src'], "'self'")
  assert.ok(DEFAULT_CSP_DIRECTIVES['script-src'].includes("'self'"))
  assert.ok(DEFAULT_CSP_DIRECTIVES['script-src'].includes('https://accounts.google.com'))
  assert.ok(DEFAULT_CSP_DIRECTIVES['style-src'].includes("'self'"))
  assert.ok(DEFAULT_CSP_DIRECTIVES['style-src'].includes('https://fonts.googleapis.com'))
  assert.ok(DEFAULT_CSP_DIRECTIVES['font-src'].includes('https://fonts.gstatic.com'))
  assert.ok(DEFAULT_CSP_DIRECTIVES['img-src'].includes('https://lh3.googleusercontent.com'))
  assert.ok(DEFAULT_CSP_DIRECTIVES['media-src'].includes("'self'"))
  assert.ok(DEFAULT_CSP_DIRECTIVES['connect-src'].includes('https://accounts.google.com'))
  assert.equal(DEFAULT_CSP_DIRECTIVES['object-src'], "'none'")
  assert.equal(DEFAULT_CSP_DIRECTIVES['base-uri'], "'self'")
  assert.equal(DEFAULT_CSP_DIRECTIVES['form-action'], "'self'")
  assert.equal(DEFAULT_CSP_DIRECTIVES['frame-ancestors'], "'self'")
})

test('isSensitivePath identifies credential and user management endpoints', () => {
  assert.equal(isSensitivePath('/api/v1/auth/me'), true)
  assert.equal(isSensitivePath('/api/v1/auth/login'), true)
  assert.equal(isSensitivePath('/api/v1/api-keys'), true)
  assert.equal(isSensitivePath('/api/v1/api-keys/key-123'), true)
  assert.equal(isSensitivePath('/api/v1/settings'), true)
  assert.equal(isSensitivePath('/api/v1/users'), true)
  assert.equal(isSensitivePath('/api/v1/admin/users'), true)

  // Non-sensitive paths
  assert.equal(isSensitivePath('/health'), false)
  assert.equal(isSensitivePath('/ready'), false)
  assert.equal(isSensitivePath('/api/v1/projects'), false)
  assert.equal(isSensitivePath('/storage/outputs/video.mp4'), false)
  assert.equal(isSensitivePath(null), false)
  assert.equal(isSensitivePath(''), false)
})

// -------------------------------------------------------------
// SECTION 2: Express Integration & E2E HTTP Verification
// -------------------------------------------------------------
console.log('\n--- SECTION 2: Express Server Integration & Security Headers ---')

// Create a test Express application with realistic routing
const tmpStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'sec18-storage-'))
const uploadsDir = path.join(tmpStorage, 'uploads')
fs.mkdirSync(uploadsDir, { recursive: true })
const sampleVideoPath = path.join(uploadsDir, 'testvideo.mp4')
// Minimal valid MP4 header
const mp4Buf = Buffer.alloc(64)
mp4Buf.writeUInt32BE(24, 0)
mp4Buf.write('ftyp', 4, 'ascii')
mp4Buf.write('isom', 8, 'ascii')
fs.writeFileSync(sampleVideoPath, mp4Buf)

const app = express()
app.disable('x-powered-by')
app.use(securityHeadersMiddleware())

// Mock routes
app.get('/health', (req, res) => res.json({ status: 'ok' }))
app.get('/api/v1/projects', (req, res) => res.json({ projects: [] }))
app.get('/api/v1/auth/me', (req, res) => res.json({ user: { id: 'u1', email: 'test@example.com' } }))
app.get('/api/v1/api-keys', (req, res) => res.json({ keys: [] }))
app.get('/api/v1/settings', (req, res) => res.json({ settings: {} }))
app.get('/api/v1/admin/users', (req, res) => res.json({ users: [] }))

// Storage static route
app.use('/storage', createSafeMediaStatic({ storageDir: tmpStorage }))

const server = app.listen(0)
await once(server, 'listening')
const baseUrl = `http://127.0.0.1:${server.address().port}`

await asyncTest('All responses include ASVS L2 browser protection headers', async () => {
  const res = await fetch(`${baseUrl}/health`)
  assert.equal(res.status, 200)

  // 1. MIME Sniffing protection
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')

  // 2. Clickjacking protection
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN')

  // 3. Referrer protection
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin')

  // 4. Feature restriction
  assert.equal(res.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=()')

  // 5. Cross-Origin-Opener-Policy
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups')
})

await asyncTest('Server fingerprint X-Powered-By is completely eliminated', async () => {
  const res = await fetch(`${baseUrl}/health`)
  assert.equal(res.headers.get('x-powered-by'), null)
})

await asyncTest('Content-Security-Policy (CSP) header is present and properly formulated', async () => {
  const res = await fetch(`${baseUrl}/api/v1/projects`)
  const csp = res.headers.get('content-security-policy')
  assert.ok(csp, 'CSP header should be present')

  // Verify critical directives
  assert.ok(csp.includes("default-src 'self'"), 'CSP includes default-src')
  assert.ok(csp.includes("script-src 'self' 'unsafe-inline' https://accounts.google.com"), 'CSP includes script-src')
  assert.ok(csp.includes("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"), 'CSP includes style-src')
  assert.ok(csp.includes("img-src 'self' data: blob: https://lh3.googleusercontent.com"), 'CSP includes img-src')
  assert.ok(csp.includes("media-src 'self' blob: data:"), 'CSP includes media-src')
  assert.ok(csp.includes("connect-src 'self' data: blob: https://accounts.google.com https://oauth2.googleapis.com"), 'CSP includes connect-src')
  assert.ok(csp.includes("object-src 'none'"), 'CSP includes object-src none')
  assert.ok(csp.includes("base-uri 'self'"), 'CSP includes base-uri self')
  assert.ok(csp.includes("form-action 'self'"), 'CSP includes form-action self')
  assert.ok(csp.includes("frame-ancestors 'self'"), 'CSP includes frame-ancestors self')
})

await asyncTest('Tiered CORP: same-origin for API endpoints', async () => {
  const resApi = await fetch(`${baseUrl}/api/v1/projects`)
  assert.equal(resApi.headers.get('cross-origin-resource-policy'), 'same-origin')

  const resHealth = await fetch(`${baseUrl}/health`)
  assert.equal(resHealth.headers.get('cross-origin-resource-policy'), 'same-origin')
})

await asyncTest('Tiered CORP: cross-origin and CORS wildcard for /storage/* media playback', async () => {
  const resMedia = await fetch(`${baseUrl}/storage/uploads/testvideo.mp4`)
  assert.equal(resMedia.status, 200)

  // Critical: must be cross-origin so Canvas and Web Audio API are not tainted
  assert.equal(resMedia.headers.get('cross-origin-resource-policy'), 'cross-origin')
  assert.equal(resMedia.headers.get('access-control-allow-origin'), '*')
  assert.equal(resMedia.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(resMedia.headers.get('content-disposition'), 'inline')
})

await asyncTest('Tiered Cache-Control: strict no-cache on sensitive auth endpoints', async () => {
  const res = await fetch(`${baseUrl}/api/v1/auth/me`)
  assert.equal(res.status, 200)

  assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, proxy-revalidate')
  assert.equal(res.headers.get('pragma'), 'no-cache')
  assert.equal(res.headers.get('expires'), '0')
  assert.equal(res.headers.get('surrogate-control'), 'no-store')
})

await asyncTest('Tiered Cache-Control: strict no-cache on sensitive API keys endpoints', async () => {
  const res = await fetch(`${baseUrl}/api/v1/api-keys`)
  assert.equal(res.status, 200)

  assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, proxy-revalidate')
  assert.equal(res.headers.get('pragma'), 'no-cache')
  assert.equal(res.headers.get('expires'), '0')
  assert.equal(res.headers.get('surrogate-control'), 'no-store')
})

await asyncTest('Tiered Cache-Control: strict no-cache on sensitive settings endpoints', async () => {
  const res = await fetch(`${baseUrl}/api/v1/settings`)
  assert.equal(res.status, 200)

  assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, proxy-revalidate')
  assert.equal(res.headers.get('pragma'), 'no-cache')
  assert.equal(res.headers.get('expires'), '0')
  assert.equal(res.headers.get('surrogate-control'), 'no-store')
})

await asyncTest('Tiered Cache-Control: strict no-cache on sensitive admin endpoints', async () => {
  const res = await fetch(`${baseUrl}/api/v1/admin/users`)
  assert.equal(res.status, 200)

  assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, proxy-revalidate')
  assert.equal(res.headers.get('pragma'), 'no-cache')
  assert.equal(res.headers.get('expires'), '0')
  assert.equal(res.headers.get('surrogate-control'), 'no-store')
})

await asyncTest('Non-sensitive endpoints (like /health) do not have no-store forced', async () => {
  const res = await fetch(`${baseUrl}/health`)
  assert.equal(res.status, 200)
  assert.notEqual(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, proxy-revalidate')
})

// Teardown
await new Promise(resolve => server.close(resolve))
try {
  fs.rmSync(tmpStorage, { recursive: true, force: true })
} catch (_) {}

console.log(`\nALL TASK 18 SECURITY HEADER TESTS PASS (${totalAssertions} assertions verified)`)

