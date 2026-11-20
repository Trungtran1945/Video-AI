// Security Hardening TASK-01: Hide & Protect API Keys / Secrets
// Run: node backend/tests/securityTask01Secrets.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertProductionSecrets,
  assertDatabaseSecrets,
  isPlaceholderSecret,
  maskSecret,
  redactSensitiveString,
  DEV_ACCESS_SECRET,
  DEV_REFRESH_SECRET,
  DEV_MASTER_KEY,
  DEV_DB_PASSWORD,
  MIN_SECRET_LENGTH,
  MIN_DB_PASSWORD_LENGTH,
} from '../src/config.js'

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log('PASS:', msg)
  } else {
    failures++
    console.error('FAIL:', msg)
  }
}

const strongSecret = (prefix) => `${prefix}_${'0123456789abcdef'.repeat(3)}`
const strongDbPass = 'SuperSecretDbPass_2026!_Secure'

console.log('=== TASK 1: Hide & Protect API Keys / Secrets Test Suite ===\n')

// 1. Placeholder Secret Classifier
console.log('--- 1. Placeholder Classifier ---')
assert(isPlaceholderSecret(DEV_ACCESS_SECRET) === true, 'dev access secret is identified as placeholder')
assert(isPlaceholderSecret(DEV_REFRESH_SECRET) === true, 'dev refresh secret is identified as placeholder')
assert(isPlaceholderSecret(DEV_MASTER_KEY) === true, 'dev master key is identified as placeholder')
assert(isPlaceholderSecret(DEV_DB_PASSWORD) === true, 'dev db password is identified as placeholder')
assert(isPlaceholderSecret('change-me-in-production') === true, 'change-me-in-production is identified as placeholder')
assert(isPlaceholderSecret('postgres') === true, 'default postgres is identified as placeholder')
assert(isPlaceholderSecret('') === true, 'empty string is identified as placeholder')
assert(isPlaceholderSecret(null) === true, 'null is identified as placeholder')
assert(isPlaceholderSecret(undefined) === true, 'undefined is identified as placeholder')
assert(isPlaceholderSecret(strongSecret('custom')) === false, 'strong secret is not identified as placeholder')
assert(isPlaceholderSecret(strongDbPass) === false, 'strong db pass is not identified as placeholder')

// 2. Production Secrets Validator
console.log('\n--- 2. Production Secrets Validation ---')
{
  // 2.1 Valid production secrets pass
  let threw = false
  try {
    assertProductionSecrets({
      nodeEnv: 'production',
      jwtAccessSecret: strongSecret('access'),
      jwtRefreshSecret: strongSecret('refresh'),
      masterKey: strongSecret('master'),
    })
  } catch (_) {
    threw = true
  }
  assert(!threw, 'valid production secrets pass validation')

  // 2.2 Missing secret throws in production
  let threwMissing = false
  let missingErrMsg = ''
  try {
    assertProductionSecrets({
      nodeEnv: 'production',
      jwtAccessSecret: '',
      jwtRefreshSecret: strongSecret('refresh'),
      masterKey: strongSecret('master'),
    })
  } catch (err) {
    threwMissing = true
    missingErrMsg = err.message
  }
  assert(threwMissing, 'missing secret throws in production')
  assert(missingErrMsg.includes('JWT_ACCESS_SECRET'), 'error message names the missing secret variable')
  assert(!missingErrMsg.includes(strongSecret('refresh')), 'error message never leaks valid secret values')

  // 2.3 Short secret (< 32 chars) throws in production
  let threwShort = false
  try {
    assertProductionSecrets({
      nodeEnv: 'production',
      jwtAccessSecret: strongSecret('access'),
      jwtRefreshSecret: 'too-short-secret',
      masterKey: strongSecret('master'),
    })
  } catch (_) {
    threwShort = true
  }
  assert(threwShort, 'short secret (< 32 chars) throws in production')

  // 2.4 Placeholder secret throws in production
  let threwPlaceholder = false
  try {
    assertProductionSecrets({
      nodeEnv: 'production',
      jwtAccessSecret: DEV_ACCESS_SECRET,
      jwtRefreshSecret: strongSecret('refresh'),
      masterKey: strongSecret('master'),
    })
  } catch (_) {
    threwPlaceholder = true
  }
  assert(threwPlaceholder, 'placeholder secret throws in production')

  // 2.5 Strict secrets mode enforcement even in non-production
  let threwStrict = false
  try {
    assertProductionSecrets({
      nodeEnv: 'development',
      strictSecrets: true,
      jwtAccessSecret: DEV_ACCESS_SECRET,
      jwtRefreshSecret: strongSecret('refresh'),
      masterKey: strongSecret('master'),
    })
  } catch (_) {
    threwStrict = true
  }
  assert(threwStrict, 'strictSecrets=true enforces secret strength even in development')

  // 2.6 Normal development allows dev fallback
  let threwDev = false
  try {
    assertProductionSecrets({
      nodeEnv: 'development',
      strictSecrets: false,
      jwtAccessSecret: DEV_ACCESS_SECRET,
      jwtRefreshSecret: DEV_REFRESH_SECRET,
      masterKey: DEV_MASTER_KEY,
    })
  } catch (_) {
    threwDev = true
  }
  assert(!threwDev, 'development mode allows dev fallback when not strict')
}

// 3. Database Secrets Validator
console.log('\n--- 3. Database Secrets Validation ---')
{
  // 3.1 Valid database credentials pass
  let threw = false
  try {
    assertDatabaseSecrets({
      nodeEnv: 'production',
      dbPassword: strongDbPass,
    })
  } catch (_) {
    threw = true
  }
  assert(!threw, 'strong db password passes in production')

  // 3.2 Default DB password fails in production
  let threwDefaultPass = false
  let defaultPassErrMsg = ''
  try {
    assertDatabaseSecrets({
      nodeEnv: 'production',
      dbPassword: DEV_DB_PASSWORD,
    })
  } catch (err) {
    threwDefaultPass = true
    defaultPassErrMsg = err.message
  }
  assert(threwDefaultPass, 'default db password throws in production')
  assert(defaultPassErrMsg.includes('DB_PASSWORD'), 'error message references DB_PASSWORD variable')
  assert(!defaultPassErrMsg.includes(DEV_DB_PASSWORD), 'error message never leaks default password value')

  // 3.3 Short DB password (< 16 chars) fails in production
  let threwShortPass = false
  try {
    assertDatabaseSecrets({
      nodeEnv: 'production',
      dbPassword: 'short_pass_123',
    })
  } catch (_) {
    threwShortPass = true
  }
  assert(threwShortPass, 'short db password (< 16 chars) throws in production')

  // 3.4 DATABASE_URL containing default password fails in production
  let threwDefaultUrl = false
  try {
    assertDatabaseSecrets({
      nodeEnv: 'production',
      databaseUrl: `postgresql://video_ai_user:${DEV_DB_PASSWORD}@postgres:5432/video_ai`,
    })
  } catch (_) {
    threwDefaultUrl = true
  }
  assert(threwDefaultUrl, 'DATABASE_URL with default password throws in production')

  // 3.5 DATABASE_URL with strong password passes in production
  let threwStrongUrl = false
  try {
    assertDatabaseSecrets({
      nodeEnv: 'production',
      databaseUrl: `postgresql://video_ai_user:${strongDbPass}@postgres:5432/video_ai`,
    })
  } catch (_) {
    threwStrongUrl = true
  }
  assert(!threwStrongUrl, 'DATABASE_URL with strong password passes in production')

  // 3.6 STRICT_SECRETS=true fails on default DB password even in development
  let threwStrictDb = false
  try {
    assertDatabaseSecrets({
      nodeEnv: 'development',
      strictSecrets: true,
      dbPassword: DEV_DB_PASSWORD,
    })
  } catch (_) {
    threwStrictDb = true
  }
  assert(threwStrictDb, 'strictSecrets=true enforces db password safety in development')

  // 3.7 Non-production with test db passes without error
  let threwTestDb = false
  try {
    assertDatabaseSecrets({
      nodeEnv: 'test',
      databaseUrl: `postgresql://video_ai_user:${DEV_DB_PASSWORD}@localhost:5433/video_ai_test`,
    })
  } catch (_) {
    threwTestDb = true
  }
  assert(!threwTestDb, 'test database URL passes in test environment')
}

// 4. Secret Redaction & Masking Utilities
console.log('\n--- 4. Secret Redaction & Masking ---')
{
  // 4.1 Masking
  assert(maskSecret('') === '', 'empty secret masks to empty')
  assert(maskSecret('12345') === '****', 'short secret (<= 8 chars) masks to ****')
  assert(maskSecret('abcdefghij') === 'ab****ij', 'normal secret shows first 2 and last 2')
  assert(maskSecret(strongSecret('key')) === 'ke****ef', 'long secret masks middle characters')

  // 4.2 Redaction
  const pgUrl = 'postgresql://video_ai_user:super_secret_db_pass_123@localhost:5433/video_ai'
  const redactedPg = redactSensitiveString(pgUrl)
  assert(!redactedPg.includes('super_secret_db_pass_123'), 'redactSensitiveString removes postgres password')
  assert(redactedPg.includes('[REDACTED]'), 'redactSensitiveString inserts [REDACTED]')

  const redisUrl = 'redis://:super_redis_auth_pass@redis:6379'
  const redactedRedis = redactSensitiveString(redisUrl)
  assert(!redactedRedis.includes('super_redis_auth_pass'), 'redactSensitiveString removes redis password')

  const bearerHeader = 'Authorization: Bearer my_super_secret_jwt_token_123456789'
  const redactedBearer = redactSensitiveString(bearerHeader)
  assert(!redactedBearer.includes('my_super_secret_jwt_token_123456789'), 'redactSensitiveString removes bearer token')

  const apiKeyMsg = 'Error calling gemini with apiKey=AIzaSyD-abc1234567890xyz'
  const redactedKey = redactSensitiveString(apiKeyMsg)
  assert(!redactedKey.includes('AIzaSyD-abc1234567890xyz'), 'redactSensitiveString removes apiKey value')
}

// 5. File & Config Contract Inspection
console.log('\n--- 5. Static Code Inspection ---')
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const configSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8')
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8')
  const composeSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-compose.yml'), 'utf8')

  assert(configSrc.includes('assertDatabaseSecrets'), 'config.js exports assertDatabaseSecrets')
  assert(configSrc.includes('redactSensitiveString'), 'config.js exports redactSensitiveString')
  assert(configSrc.includes('maskSecret'), 'config.js exports maskSecret')
  assert(dbSrc.includes('assertDatabaseSecrets'), 'db.js invokes assertDatabaseSecrets')
  assert(composeSrc.includes('STRICT_SECRETS'), 'docker-compose.yml configures STRICT_SECRETS pass-through')
}

console.log(failures === 0 ? '\nALL TASK 1 TESTS PASS' : `\n${failures} FAILURES IN TASK 1`)
process.exit(failures === 0 ? 0 : 1)
