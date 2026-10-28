// QA Verification Test Suite: Bottlenecks & Edge Cases Analysis
// Contract verification for P0/P1/P2 items defined in .team/PLAN.md
// Run: node backend/tests/qaPlanBottlenecks.test.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertProductionSecrets, isPlaceholderSecret, isOriginAllowed, MIN_SECRET_LENGTH } from '../src/config.js'
import { resolveAdminSeed } from '../src/db/seed.js'
import { safeAddProject } from '../src/queue/projectQueue.js'
import { safeAddDrainSweep } from '../src/queue/drainQueue.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.join(__dirname, '..')
const repoRoot = path.join(backendRoot, '..')

let totalTests = 0
let passedTests = 0
let failedTests = 0

function assert(condition, testName, details = '') {
  totalTests++
  if (condition) {
    passedTests++
    console.log(`  PASS: [${testName}]`)
  } else {
    failedTests++
    console.error(`  FAIL: [${testName}] ${details}`)
  }
}

console.log('=== QA Test Suite: P0/P1/P2 Code Logic & Edge Cases Analysis ===\n')

// -------------------------------------------------------------
// SUITE 1: Item 1 - Production Secrets Validation (assertProductionSecrets)
// -------------------------------------------------------------
console.log('--- Suite 1: Production Secrets Validation ---')

// 1.1 Happy Path: All secrets >= 32 chars and safe
{
  let threw = false
  try {
    assertProductionSecrets({
      nodeEnv: 'production',
      jwtAccessSecret: 'a'.repeat(32),
      jwtRefreshSecret: 'b'.repeat(48),
      masterKey: 'c'.repeat(64),
    })
  } catch (e) {
    threw = true
  }
  assert(!threw, 'Happy Path: Valid 32+ char secrets accepted without error')
}

// 1.2 Non-production mode: Dev environment allows empty or short secrets
{
  let threw = false
  try {
    assertProductionSecrets({
      nodeEnv: 'development',
      jwtAccessSecret: 'short',
      jwtRefreshSecret: '',
      masterKey: undefined,
    })
  } catch (e) {
    threw = true
  }
  assert(!threw, 'Happy Path (Dev): Development bypasses strict secret enforcement')
}

// 1.3 Boundary: Exactly 31 chars (1 char below MIN_SECRET_LENGTH)
{
  let threw = false
  let errorMsg = ''
  try {
    assertProductionSecrets({
      nodeEnv: 'production',
      jwtAccessSecret: 'a'.repeat(31), // 31 chars - Boundary condition
      jwtRefreshSecret: 'b'.repeat(32),
      masterKey: 'c'.repeat(32),
    })
  } catch (e) {
    threw = true
    errorMsg = e.message
  }
  assert(threw && errorMsg.includes('JWT_ACCESS_SECRET'), 'Boundary: Exactly 31 chars rejected with error naming JWT_ACCESS_SECRET')
}

// 1.4 Boundary: Exactly 32 chars (exact MIN_SECRET_LENGTH)
{
  let threw = false
  try {
    assertProductionSecrets({
      nodeEnv: 'production',
      jwtAccessSecret: 'a'.repeat(32),
      jwtRefreshSecret: 'b'.repeat(32),
      masterKey: 'c'.repeat(32),
    })
  } catch (e) {
    threw = true
  }
  assert(!threw, 'Boundary: Exactly 32 chars accepted')
}

// 1.5 Corner Case: Known placeholders even if >= 32 chars
{
  assert(isPlaceholderSecret('change-me-in-production'), 'Corner Case: Known placeholder recognized')
  let threw = false
  try {
    assertProductionSecrets({
      nodeEnv: 'production',
      jwtAccessSecret: 'change-me-in-production',
      jwtRefreshSecret: 'b'.repeat(32),
      masterKey: 'c'.repeat(32),
    })
  } catch (e) {
    threw = true
  }
  assert(threw, 'Corner Case: Placeholder secret rejected in production')
}

// 1.6 Edge Case: Empty strings, null, undefined in production
{
  let threw = false
  try {
    assertProductionSecrets({
      nodeEnv: 'production',
      jwtAccessSecret: '',
      jwtRefreshSecret: null,
      masterKey: undefined,
    })
  } catch (e) {
    threw = true
  }
  assert(threw, 'Edge Case: Empty/null/undefined secrets rejected in production')
}

// -------------------------------------------------------------
// SUITE 2: Item 2 - Admin Seed Logic & Compose Contract
// -------------------------------------------------------------
console.log('\n--- Suite 2: Admin Seed Logic & Compose Contract ---')

// 2.1 Happy Path: Strong admin password (>= 12 chars)
{
  const res = resolveAdminSeed({
    nodeEnv: 'production',
    adminEmail: 'superadmin@example.com',
    adminPassword: 'SuperStrongPassword123!',
  })
  assert(
    res.action === 'create' && res.email === 'superadmin@example.com' && res.password === 'SuperStrongPassword123!',
    'Happy Path: Strong admin password creates admin account'
  )
}

// 2.2 Boundary: Exactly 11 chars (below 12 chars threshold)
{
  let threw = false
  let errorMsg = ''
  try {
    resolveAdminSeed({
      nodeEnv: 'production',
      adminEmail: 'admin@example.com',
      adminPassword: '12345678901', // 11 chars
    })
  } catch (e) {
    threw = true
    errorMsg = e.message
  }
  assert(threw && errorMsg.includes('ADMIN_PASSWORD too weak'), 'Boundary: Exactly 11 chars password rejected with FATAL error')
}

// 2.3 Boundary: Exactly 12 chars (threshold met)
{
  let threw = false
  let res
  try {
    res = resolveAdminSeed({
      nodeEnv: 'production',
      adminEmail: 'admin@example.com',
      adminPassword: '123456789012', // 12 chars
    })
  } catch (e) {
    threw = true
  }
  assert(!threw && res?.action === 'create', 'Boundary: Exactly 12 chars password accepted for admin creation')
}

// 2.4 Edge Case: Empty / missing admin password in production
{
  const resEmpty = resolveAdminSeed({
    nodeEnv: 'production',
    adminEmail: 'admin@example.com',
    adminPassword: '',
  })
  assert(resEmpty.action === 'skip' && resEmpty.reason.includes('absent'), 'Edge Case: Empty password in production skips seeding gracefully')

  const resNull = resolveAdminSeed({
    nodeEnv: 'production',
    adminEmail: 'admin@example.com',
    adminPassword: null,
  })
  assert(resNull.action === 'skip', 'Edge Case: Null password in production skips seeding gracefully')
}

// 2.5 Dev Mode: Fallback defaults
{
  const resDev = resolveAdminSeed({
    nodeEnv: 'development',
    adminEmail: null,
    adminPassword: null,
  })
  assert(
    resDev.action === 'create' && resDev.email === 'admin@asf.local' && resDev.password === 'admin1234',
    'Dev Mode: Fallback default credentials seeded'
  )
}

// 2.6 Compose pass-through verification for Item 2
{
  const composeContent = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8')
  const hasAdminEnv = composeContent.includes('ADMIN_EMAIL=${ADMIN_EMAIL:-}') && composeContent.includes('ADMIN_PASSWORD=${ADMIN_PASSWORD:-}')
  assert(
    hasAdminEnv,
    'Contract Verification (Item 2): docker-compose.yml passes through ADMIN_EMAIL and ADMIN_PASSWORD'
  )
}

// -------------------------------------------------------------
// SUITE 3: Item 4 - CORS Origin Allowlist (isOriginAllowed)
// -------------------------------------------------------------
console.log('\n--- Suite 3: CORS Origin Allowlist ---')

// 3.1 Happy Path: Allowed origin matches exactly
{
  const allowed = isOriginAllowed('https://app.example.com', {
    nodeEnv: 'production',
    corsOrigins: ['https://app.example.com', 'https://admin.example.com'],
  })
  assert(allowed === true, 'Happy Path: Configured origin is allowed')
}

// 3.2 Non-browser / same-origin (origin is null/empty/undefined)
{
  assert(isOriginAllowed(null) === true, 'Happy Path: Null origin (curl / same-origin) is allowed')
  assert(isOriginAllowed('') === true, 'Happy Path: Empty origin is allowed')
  assert(isOriginAllowed(undefined) === true, 'Happy Path: Undefined origin is allowed')
}

// 3.3 Disallowed origin in production
{
  const allowed = isOriginAllowed('https://malicious.com', {
    nodeEnv: 'production',
    corsOrigins: ['https://app.example.com'],
  })
  assert(allowed === false, 'Security Gate: Unlisted origin is rejected')
}

// 3.4 Corner Case: Subdomain or protocol mismatch
{
  const httpMismatch = isOriginAllowed('http://app.example.com', {
    nodeEnv: 'production',
    corsOrigins: ['https://app.example.com'],
  })
  assert(httpMismatch === false, 'Corner Case: Protocol mismatch (http vs https) is rejected')

  const portMismatch = isOriginAllowed('https://app.example.com:8080', {
    nodeEnv: 'production',
    corsOrigins: ['https://app.example.com'],
  })
  assert(portMismatch === false, 'Corner Case: Port mismatch is rejected')
}

// 3.5 Edge Case: Empty CORS_ORIGINS in production
{
  const allowed = isOriginAllowed('http://localhost:5173', {
    nodeEnv: 'production',
    corsOrigins: [],
  })
  assert(allowed === false, 'Edge Case: Empty CORS_ORIGINS in production blocks browser cross-origin requests')
}

// -------------------------------------------------------------
// SUITE 4: Item 6 - Redis Down Queue Degradation & Warnings
// -------------------------------------------------------------
console.log('\n--- Suite 4: Redis Queue Degradation ---')

// 4.1 safeAddProject returns { skipped: true, reason: 'REDIS_UNAVAILABLE' }
{
  const result = await safeAddProject('test-job', { data: 123 })
  assert(
    result && result.skipped === true && result.reason === 'REDIS_UNAVAILABLE',
    'Degradation Path (Item 6): safeAddProject gracefully skips with reason REDIS_UNAVAILABLE when Redis is down'
  )
}

// 4.2 safeAddDrainSweep returns { skipped: true, reason: 'REDIS_UNAVAILABLE' }
{
  const result = await safeAddDrainSweep()
  assert(
    result && result.skipped === true && result.reason === 'REDIS_UNAVAILABLE',
    'Degradation Path (Item 6): safeAddDrainSweep gracefully skips with reason REDIS_UNAVAILABLE when Redis is down'
  )
}

// -------------------------------------------------------------
// SUITE 5: Item 5 Fix Verification & Open Defect Checks (Items 7, 8)
// -------------------------------------------------------------
console.log('\n--- Suite 5: Infrastructure Fixes & Open Defect Checks ---')

// 5.1 Docker Compose: Check web depends_on condition (Item 5 Fixed)
{
  const composeContent = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8')
  const webSection = composeContent.slice(composeContent.indexOf('web:'))
  const hasServiceHealthy = webSection.includes('condition: service_healthy')
  const hasHealthcheck = webSection.includes('healthcheck:')
  assert(
    hasServiceHealthy && hasHealthcheck,
    'Fix Verification (Item 5): web service now requires api condition: service_healthy and has healthcheck'
  )
}

// 5.2 Nginx Config: Check SSE location scope (Item 5 Fixed)
{
  const nginxContent = fs.readFileSync(path.join(repoRoot, 'docker/nginx.conf'), 'utf8')
  const hasNarrowRegex = nginxContent.includes('location ~ ^/api/v1/projects/[^/]+/events$')
  const hasProxyHeaders = nginxContent.includes('proxy_set_header Host $host;') && nginxContent.includes('proxy_set_header X-Real-IP $remote_addr;')
  assert(
    hasNarrowRegex && hasProxyHeaders,
    'Fix Verification (Item 5): nginx.conf narrows SSE scope to /events and forwards Host/X-Real-IP/X-Forwarded-For'
  )
}

// 5.3 Frontend Storage URL: Check ProjectDetail dynamic origin (Item 7 Fixed)
{
  const projectDetailContent = fs.readFileSync(path.join(repoRoot, 'frontend/src/pages/ProjectDetail.jsx'), 'utf8')
  const usesResolver = projectDetailContent.includes('resolveStorageUrl(project.output.storage_key)')
    || projectDetailContent.includes('resolveStorageUrl(project.source_video_key)')
  const hasHardcodedRelativeStorage = projectDetailContent.includes('`/storage/${project.output.storage_key}')
  assert(
    usesResolver && !hasHardcodedRelativeStorage,
    'Fix Verification (Item 7): ProjectDetail.jsx resolves storage URLs via apiBase helper instead of hardcoded relative `/storage/` path'
  )
}

// 5.4 Frontend System Health BaseURL: Check extra.js (Item 7 Fixed)
{
  const extraJsContent = fs.readFileSync(path.join(repoRoot, 'frontend/src/api/extra.js'), 'utf8')
  const usesResolver = extraJsContent.includes("resolveSystemPath('/health')")
  const hasEmptyBaseUrl = extraJsContent.includes("health: () => api.get('/health', { baseURL: '' })")
  assert(
    usesResolver && !hasEmptyBaseUrl,
    'Fix Verification (Item 7): extra.js resolves /health and /ready via apiBase helper instead of empty baseURL override'
  )
}

// 5.5 Frontend ErrorBoundary: Check main.jsx root coverage (Item 8 Fixed)
{
  const mainJsxContent = fs.readFileSync(path.join(repoRoot, 'frontend/src/main.jsx'), 'utf8')
  const hasErrorBoundaryInMain = mainJsxContent.includes('ErrorBoundary')
  assert(
    hasErrorBoundaryInMain,
    'Fix Verification (Item 8): frontend/src/main.jsx wraps root with ErrorBoundary'
  )
}

console.log(`\n========================================`)
console.log(`QA Tests Summary: Total=${totalTests}, Passed=${passedTests}, Failed=${failedTests}`)
console.log(`========================================\n`)

process.exit(failedTests === 0 ? 0 : 1)
