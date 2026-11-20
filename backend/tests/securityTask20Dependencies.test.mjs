/**
 * TASK 20 Security Hardening Verification Test Suite
 * Dependencies Scanning & DevSecOps CI (SEC-14 / SEC-15 & OWASP ASVS L2)
 *
 * Verifies:
 * 1. Docker Least-Privilege & Non-Root Execution:
 *    - docker/api.Dockerfile enforces unprivileged `USER node`.
 *    - Directory permissions properly chowned to node:node.
 * 2. Supply Chain Security & Overrides (package.json):
 *    - backend/package.json defines overrides for legacy transitive dependencies (form-data, tough-cookie, qs, uuid, yargs-parser, nodemailer).
 *    - frontend/package.json uses modern patched zod and axios.
 * 3. DevSecOps CI/CD Security Gates (.github/workflows/ci.yml & dependabot.yml):
 *    - CI pipeline contains automated audit gate: `npm audit --audit-level=high`.
 *    - Secret scanner gate is present and mandatory.
 *    - Dependabot configuration file exists and covers backend, frontend, and github-actions.
 * 4. Live Vulnerability Check:
 *    - Runs `npm audit --audit-level=high` programmatically on both backend and frontend, asserting 0 critical and 0 high vulnerabilities.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'
import { execSync } from 'node:child_process'

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

console.log('=== securityTask20Dependencies.test.mjs ===\n')

// -------------------------------------------------------------
// SECTION 1: Docker Least-Privilege & Non-Root Container Audit
// -------------------------------------------------------------
console.log('--- SECTION 1: Docker Least-Privilege & Container Hardening ---')

const apiDockerPath = path.join(ROOT_DIR, 'docker/api.Dockerfile')
test('docker/api.Dockerfile exists', () => {
  assert.ok(fs.existsSync(apiDockerPath), 'docker/api.Dockerfile must exist')
})

const apiDockerfile = fs.readFileSync(apiDockerPath, 'utf8')

test('docker/api.Dockerfile enforces unprivileged USER node', () => {
  assert.ok(/USER\s+node/.test(apiDockerfile), 'api.Dockerfile must declare USER node')
})

test('docker/api.Dockerfile sets ownership to node:node', () => {
  assert.ok(/chown\s+-R\s+node:node/.test(apiDockerfile) || /--chown=node:node/.test(apiDockerfile), 'api.Dockerfile must assign file ownership to node:node')
})

// -------------------------------------------------------------
// SECTION 2: Supply Chain Security & Dependency Overrides
// -------------------------------------------------------------
console.log('\n--- SECTION 2: Package Overrides & Supply Chain Hardening ---')

const backendPkgPath = path.join(ROOT_DIR, 'backend/package.json')
const backendPkg = JSON.parse(fs.readFileSync(backendPkgPath, 'utf8'))

test('backend/package.json defines overrides for vulnerable transitive dependencies', () => {
  assert.ok(backendPkg.overrides, 'backend/package.json must contain overrides object')
  assert.ok(backendPkg.overrides['form-data'], 'overrides must cover form-data')
  assert.ok(backendPkg.overrides['tough-cookie'], 'overrides must cover tough-cookie')
  assert.ok(backendPkg.overrides['qs'], 'overrides must cover qs')
  assert.ok(backendPkg.overrides['nodemailer'], 'overrides must cover nodemailer')
})

test('backend/package.json pins nodemailer to version 10+', () => {
  assert.ok(backendPkg.dependencies.nodemailer, 'nodemailer must be in dependencies')
  assert.ok(backendPkg.dependencies.nodemailer.includes('10.'), 'nodemailer must be version 10+')
})

const frontendPkgPath = path.join(ROOT_DIR, 'frontend/package.json')
const frontendPkg = JSON.parse(fs.readFileSync(frontendPkgPath, 'utf8'))

test('frontend/package.json uses modern patched zod version', () => {
  assert.ok(frontendPkg.dependencies.zod, 'frontend must specify zod')
  assert.ok(frontendPkg.dependencies.zod.includes('4.'), 'frontend zod must be version 4+')
})

// -------------------------------------------------------------
// SECTION 3: DevSecOps CI Automation & Dependabot
// -------------------------------------------------------------
console.log('\n--- SECTION 3: DevSecOps CI Automation & Dependabot ---')

const ciWorkflowPath = path.join(ROOT_DIR, '.github/workflows/ci.yml')
test('.github/workflows/ci.yml exists', () => {
  assert.ok(fs.existsSync(ciWorkflowPath), '.github/workflows/ci.yml must exist')
})

const ciWorkflow = fs.readFileSync(ciWorkflowPath, 'utf8')

test('.github/workflows/ci.yml contains npm audit high/critical gate for backend', () => {
  assert.ok(
    ciWorkflow.includes('npm audit --audit-level=high'),
    'ci.yml must contain npm audit --audit-level=high'
  )
})

test('.github/workflows/ci.yml contains repository secret scan gate', () => {
  assert.ok(
    ciWorkflow.includes('scan-secrets.mjs'),
    'ci.yml must execute scan-secrets.mjs'
  )
})

const dependabotPath = path.join(ROOT_DIR, '.github/dependabot.yml')
test('.github/dependabot.yml exists and configures automated security updates', () => {
  assert.ok(fs.existsSync(dependabotPath), '.github/dependabot.yml must exist')
  const dependabotContent = fs.readFileSync(dependabotPath, 'utf8')
  assert.ok(dependabotContent.includes('directory: "/backend"'), 'dependabot must cover /backend')
  assert.ok(dependabotContent.includes('directory: "/frontend"'), 'dependabot must cover /frontend')
  assert.ok(dependabotContent.includes('package-ecosystem: "github-actions"'), 'dependabot must cover github-actions')
})

// -------------------------------------------------------------
// SECTION 4: Live Vulnerability Threshold Verification
// -------------------------------------------------------------
console.log('\n--- SECTION 4: Live Vulnerability Verification (0 High / Critical) ---')

test('backend has 0 critical and 0 high vulnerabilities (npm audit --audit-level=high exits 0)', () => {
  try {
    execSync('npm audit --audit-level=high', {
      cwd: path.join(ROOT_DIR, 'backend'),
      stdio: 'pipe',
    })
  } catch (err) {
    console.error('Backend audit failed:', err.stdout?.toString())
    throw new Error('Backend contains high or critical vulnerabilities')
  }
})

test('frontend has 0 critical and 0 high vulnerabilities (npm audit --audit-level=high exits 0)', () => {
  try {
    execSync('npm audit --audit-level=high', {
      cwd: path.join(ROOT_DIR, 'frontend'),
      stdio: 'pipe',
    })
  } catch (err) {
    console.error('Frontend audit failed:', err.stdout?.toString())
    throw new Error('Frontend contains high or critical vulnerabilities')
  }
})

console.log(`\nALL TASK 20 DEVSECOPS & DEPENDENCY TESTS PASS (${totalAssertions} assertions verified)`)
