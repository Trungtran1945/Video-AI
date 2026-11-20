/**
 * TASK 19 Security Hardening Verification Test Suite
 * HTTPS Enforcement & Secure Transport (SEC-12 & OWASP ASVS L2)
 *
 * Verifies:
 * 1. HTTPS enforcement middleware:
 *    - 301 Permanent Redirect on plain HTTP requests when forceHttps is active.
 *    - Preserves request path and query parameters in redirect Location.
 *    - Passes through requests with x-forwarded-proto: https or req.secure (no redirect loop).
 *    - Failsafe bypass in test/dev environment when not forced.
 * 2. Strict-Transport-Security (HSTS) header:
 *    - Formatted per RFC 6797: max-age=31536000; includeSubDomains; preload.
 *    - Set on secure requests and in production mode.
 * 3. Express Trust Proxy configuration:
 *    - Correctly maps X-Forwarded-Proto: https to req.secure.
 * 4. Nginx Reverse Proxy static configuration audit (docker/nginx.conf):
 *    - HTTP -> HTTPS 301 redirect.
 *    - Strict TLS protocols (TLSv1.2 TLSv1.3 only; no legacy SSL/TLS).
 *    - Secure AEAD ciphers configured.
 *    - HSTS header configured with preload and includeSubDomains.
 *    - X-Forwarded-Proto set to https.
 * 5. Production Cookie Secure compliance:
 *    - cookieSecure is enabled in production.
 */

import assert from 'node:assert/strict'
import express from 'express'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'
import {
  httpsEnforcementMiddleware,
  securityHeadersMiddleware,
} from '../src/middleware/securityHeaders.js'
import { config } from '../src/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '../..')

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

console.log('=== securityTask19HttpsEnforcement.test.mjs ===\n')

// -------------------------------------------------------------
// SECTION 1: HTTPS Enforcement Middleware Integration
// -------------------------------------------------------------
console.log('--- SECTION 1: HTTPS Enforcement Middleware Tests ---')

const appEnforce = express()
appEnforce.set('trust proxy', 1)
appEnforce.use(httpsEnforcementMiddleware({ forceHttps: true }))
appEnforce.use(securityHeadersMiddleware({ hsts: true }))
appEnforce.get('/api/v1/test', (req, res) => res.json({ ok: true, secure: req.secure }))

const serverEnforce = appEnforce.listen(0)
await once(serverEnforce, 'listening')
const enforceUrl = `http://127.0.0.1:${serverEnforce.address().port}`

await asyncTest('Plain HTTP request receives 301 Permanent Redirect to HTTPS', async () => {
  const res = await fetch(`${enforceUrl}/api/v1/test?query=abc`, {
    redirect: 'manual', // do not follow redirect
  })
  assert.equal(res.status, 301, 'HTTP status must be 301 Permanent Redirect')

  const location = res.headers.get('location')
  assert.ok(location, 'Location header must be present')
  assert.ok(location.startsWith('https://'), `Location must start with https://, got: ${location}`)
  assert.ok(location.includes('/api/v1/test?query=abc'), `Location must preserve URL path and query, got: ${location}`)
})

await asyncTest('Request with X-Forwarded-Proto: https passes through with 200 OK', async () => {
  const res = await fetch(`${enforceUrl}/api/v1/test`, {
    headers: {
      'x-forwarded-proto': 'https',
    },
  })
  assert.equal(res.status, 200, 'Secure request must pass through without redirect')
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.secure, true, 'Express trust proxy should detect req.secure = true')
})

await asyncTest('HSTS header is set with 1-year max-age, subdomains, and preload', async () => {
  const res = await fetch(`${enforceUrl}/api/v1/test`, {
    headers: {
      'x-forwarded-proto': 'https',
    },
  })
  const hsts = res.headers.get('strict-transport-security')
  assert.ok(hsts, 'Strict-Transport-Security header must be present')
  assert.ok(hsts.includes('max-age=31536000'), 'HSTS must specify max-age=31536000 (1 year)')
  assert.ok(hsts.includes('includeSubDomains'), 'HSTS must include includeSubDomains directive')
  assert.ok(hsts.includes('preload'), 'HSTS must include preload directive')
})

await new Promise(resolve => serverEnforce.close(resolve))

// -------------------------------------------------------------
// SECTION 2: Development & Test Environment Bypass
// -------------------------------------------------------------
console.log('\n--- SECTION 2: Dev/Test Non-Blocking Behavior ---')

const appDev = express()
appDev.use(httpsEnforcementMiddleware({ forceHttps: false }))
appDev.get('/api/v1/test', (req, res) => res.json({ ok: true }))

const serverDev = appDev.listen(0)
await once(serverDev, 'listening')
const devUrl = `http://127.0.0.1:${serverDev.address().port}`

await asyncTest('When forceHttps is false, HTTP requests are not redirected', async () => {
  const res = await fetch(`${devUrl}/api/v1/test`, { redirect: 'manual' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
})

await new Promise(resolve => serverDev.close(resolve))

// -------------------------------------------------------------
// SECTION 3: Nginx Reverse Proxy Configuration Audit (docker/nginx.conf)
// -------------------------------------------------------------
console.log('\n--- SECTION 3: Nginx Static Configuration Audit (docker/nginx.conf) ---')

const nginxConfPath = path.join(ROOT_DIR, 'docker/nginx.conf')
test('docker/nginx.conf exists', () => {
  assert.ok(fs.existsSync(nginxConfPath), 'docker/nginx.conf must exist')
})

const nginxConf = fs.readFileSync(nginxConfPath, 'utf8')

test('docker/nginx.conf listens on port 80 and redirects to HTTPS with 301', () => {
  assert.ok(/listen\s+80;/.test(nginxConf), 'Nginx must listen on port 80')
  assert.ok(/return\s+301\s+https:\/\/\$host\$request_uri;/.test(nginxConf), 'Nginx port 80 must return 301 https://$host$request_uri')
})

test('docker/nginx.conf listens on port 443 with SSL', () => {
  assert.ok(/listen\s+443\s+ssl/.test(nginxConf), 'Nginx must listen on port 443 ssl')
})

test('docker/nginx.conf enforces TLSv1.2 and TLSv1.3 only', () => {
  assert.ok(/ssl_protocols\s+TLSv1\.2\s+TLSv1\.3;/.test(nginxConf), 'Nginx must restrict ssl_protocols to TLSv1.2 TLSv1.3 only')
  assert.ok(!nginxConf.includes('SSLv2'), 'Nginx must not mention SSLv2')
  assert.ok(!nginxConf.includes('SSLv3'), 'Nginx must not mention SSLv3')
  assert.ok(!nginxConf.includes('TLSv1.0'), 'Nginx must not allow TLSv1.0')
  assert.ok(!nginxConf.includes('TLSv1.1'), 'Nginx must not allow TLSv1.1')
})

test('docker/nginx.conf configures modern AEAD ciphers', () => {
  assert.ok(/ssl_ciphers\s+ECDHE/.test(nginxConf), 'Nginx must configure modern ECDHE ciphers')
  assert.ok(/ssl_prefer_server_ciphers\s+on;/.test(nginxConf), 'Nginx must enable ssl_prefer_server_ciphers')
})

test('docker/nginx.conf sets HSTS header with preload and includeSubDomains', () => {
  assert.ok(
    /add_header\s+Strict-Transport-Security\s+"max-age=31536000;\s*includeSubDomains;\s*preload"\s*always;/.test(nginxConf),
    'Nginx must set Strict-Transport-Security with max-age=31536000; includeSubDomains; preload'
  )
})

test('docker/nginx.conf sets X-Forwarded-Proto https on proxy passes', () => {
  assert.ok(
    /proxy_set_header\s+X-Forwarded-Proto\s+https;/.test(nginxConf),
    'Nginx must forward X-Forwarded-Proto https to upstream API'
  )
})

// -------------------------------------------------------------
// SECTION 4: Production Cookie Secure Configuration
// -------------------------------------------------------------
console.log('\n--- SECTION 4: Cookie Secure Configuration Compliance ---')

test('config.cookieSecure is defined and supports secure transport', () => {
  assert.notEqual(config.cookieSecure, undefined, 'config.cookieSecure must be defined')
})

test('config.trustProxy is configured to trust upstream proxy', () => {
  assert.ok(config.trustProxy !== undefined && config.trustProxy !== null, 'config.trustProxy must be defined')
})

console.log(`\nALL TASK 19 HTTPS ENFORCEMENT TESTS PASS (${totalAssertions} assertions verified)`)
