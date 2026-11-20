// Security Hardening TASK-03: Database Security & Localhost Bind Verification
// Run: node backend/tests/securityTask03Database.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  getDatabasePoolConfig,
  getPool,
  closePool,
  verifyDatabaseConstraints,
  verifyDatabaseBackupReadiness,
} from '../src/db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log('PASS:', msg)
  } else {
    failures++
    console.error('FAIL:', msg)
  }
}

console.log('=== TASK 3: Database Security & Bind Address Test Suite ===\n')

// 1. Docker Compose Bind Address Inspection (SEC-02)
console.log('--- 1. Port Bind Verification (SEC-02) ---')
{
  const composePath = path.join(repoRoot, 'docker-compose.yml')
  assert(fs.existsSync(composePath), 'docker-compose.yml exists')
  const compose = fs.readFileSync(composePath, 'utf8')

  // Postgres must bind to 127.0.0.1 only
  assert(compose.includes('127.0.0.1:${POSTGRES_PORT:-5433}:5432'), 'Postgres port bound strictly to 127.0.0.1')
  assert(!/^\s+-\s*"?5433:5432"?/m.test(compose), 'Postgres port has no 0.0.0.0 public binding')

  // API must bind to 127.0.0.1 only
  assert(compose.includes('127.0.0.1:3001:3001'), 'API port bound strictly to 127.0.0.1')
  assert(!/^\s+-\s*"3001:3001"/m.test(compose), 'API port has no 0.0.0.0 public binding')

  // VoiceStudio must bind to 127.0.0.1 only
  assert(compose.includes('127.0.0.1:3900:3900'), 'VoiceStudio port bound strictly to 127.0.0.1')
  assert(!/^\s+-\s*"3900:3900"/m.test(compose), 'VoiceStudio port has no 0.0.0.0 public binding')

  // Redis must never have public exposed ports in base compose
  assert(!compose.includes('6379:6379'), 'Redis has no public exposed port in base docker-compose.yml')

  // Local-dev Redis override must also bind strictly to 127.0.0.1
  const redisHostPath = path.join(repoRoot, 'docker-compose.redis-host.yml')
  assert(fs.existsSync(redisHostPath), 'docker-compose.redis-host.yml exists')
  const redisHost = fs.readFileSync(redisHostPath, 'utf8')
  assert(redisHost.includes('127.0.0.1:6379:6379'), 'docker-compose.redis-host.yml binds Redis strictly to 127.0.0.1')
  assert(!/^\s+-\s*"6379:6379"/m.test(redisHost), 'docker-compose.redis-host.yml has no 0.0.0.0 Redis binding')

  // Validate Docker Compose configuration
  const r = spawnSync('docker', ['compose', 'config', '--quiet'], { cwd: repoRoot, encoding: 'utf8' })
  assert(r.status === 0, 'docker compose config --quiet validates without error')
}

// 2. Connection Pool Hardening & Safety Timeouts
console.log('\n--- 2. Connection Pool Hardening ---')
{
  const poolConfig = getDatabasePoolConfig()
  assert(Number.isInteger(poolConfig.max) && poolConfig.max >= 5, `pool max connections is bounded (got ${poolConfig.max})`)
  assert(Number.isInteger(poolConfig.idleTimeoutMillis) && poolConfig.idleTimeoutMillis > 0, `pool idleTimeoutMillis configured (got ${poolConfig.idleTimeoutMillis}ms)`)
  assert(Number.isInteger(poolConfig.connectionTimeoutMillis) && poolConfig.connectionTimeoutMillis > 0, `pool connectionTimeoutMillis configured (got ${poolConfig.connectionTimeoutMillis}ms)`)
  assert(Number.isInteger(poolConfig.statement_timeout) && poolConfig.statement_timeout > 0, `pool statement_timeout configured (got ${poolConfig.statement_timeout}ms)`)
  assert(Number.isInteger(poolConfig.query_timeout) && poolConfig.query_timeout > 0, `pool query_timeout configured (got ${poolConfig.query_timeout}ms)`)
  assert(poolConfig.allowExitOnIdle === true, 'pool allows exit on idle to prevent hanging test processes')
}

// 3. Database Constraints & Foreign Key Integrity
console.log('\n--- 3. Database Constraints & Foreign Keys ---')
{
  try {
    const res = await verifyDatabaseConstraints()
    assert(res.constraintsActive === true, 'PostgreSQL active constraints verified (foreign/primary/unique keys)')
    assert(res.sampleCount > 0, `verified ${res.sampleCount} active table constraints in schema`)
  } catch (err) {
    assert(false, `verifyDatabaseConstraints failed: ${err.message}`)
  }
}

// 4. Database Backup Readiness & State
console.log('\n--- 4. Database Backup Readiness ---')
{
  try {
    const backupRes = await verifyDatabaseBackupReadiness()
    assert(backupRes.ready === true, 'Database is ready and responsive for backups/maintenance')
    assert(typeof backupRes.inRecovery === 'boolean', `inRecovery status is valid boolean (got ${backupRes.inRecovery})`)
    assert(typeof backupRes.database === 'string' && backupRes.database.length > 0, `database name verified: ${backupRes.database}`)
  } catch (err) {
    assert(false, `verifyDatabaseBackupReadiness failed: ${err.message}`)
  }
}

await closePool()

console.log(failures === 0 ? '\nALL TASK 3 TESTS PASS' : `\n${failures} FAILURES IN TASK 3`)
process.exit(failures === 0 ? 0 : 1)
