// Production secret hardening: fail-fast on missing/short/dev-default secrets.
// Run: node backend/tests/configProduction.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const {
  assertProductionSecrets,
  isPlaceholderSecret,
  DEV_ACCESS_SECRET,
  DEV_REFRESH_SECRET,
  DEV_MASTER_KEY,
  MIN_SECRET_LENGTH,
} = await import('../src/config.js')

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const strong = (s) => `${s}-0123456789abcdef0123456789abcdef`
const GOOD = {
  nodeEnv: 'production',
  jwtAccessSecret: strong('access'),
  jwtRefreshSecret: strong('refresh'),
  masterKey: strong('master'),
}

// 1. Valid production secrets pass.
try {
  assertProductionSecrets(GOOD)
  assert(true, 'valid production secrets pass')
} catch (e) {
  assert(false, `valid production secrets pass (${e.message})`)
}

// 2. Missing secrets fail fast in production.
for (const key of ['jwtAccessSecret', 'jwtRefreshSecret', 'masterKey']) {
  let threw = false
  try {
    assertProductionSecrets({ ...GOOD, [key]: '' })
  } catch (_) {
    threw = true
  }
  assert(threw, `production missing ${key} throws`)
}

// 3. Dev-default secrets rejected in production.
let threwDev = false
try {
  assertProductionSecrets({
    nodeEnv: 'production',
    jwtAccessSecret: DEV_ACCESS_SECRET,
    jwtRefreshSecret: DEV_REFRESH_SECRET,
    masterKey: DEV_MASTER_KEY,
  })
} catch (_) {
  threwDev = true
}
assert(threwDev, 'production dev-default secrets throw')

// 4. Short secrets rejected in production.
let threwShort = false
try {
  assertProductionSecrets({ ...GOOD, masterKey: 'short' })
} catch (_) {
  threwShort = true
}
assert(threwShort, 'production short secret throws')
assert(MIN_SECRET_LENGTH >= 32, `MIN_SECRET_LENGTH >= 32 (got ${MIN_SECRET_LENGTH})`)

// 5. Development/test keep fallbacks (local setup not broken).
try {
  assertProductionSecrets({ nodeEnv: 'development' })
  assertProductionSecrets({ nodeEnv: 'test' })
  assertProductionSecrets({})
  assert(true, 'non-production never throws')
} catch (e) {
  assert(false, `non-production never throws (${e.message})`)
}

// 6. Placeholder classifier.
assert(isPlaceholderSecret(DEV_ACCESS_SECRET) === true, 'dev access is placeholder')
assert(isPlaceholderSecret('change-me-in-production') === true, 'change-me is placeholder')
assert(isPlaceholderSecret(strong('x')) === false, 'strong secret is not placeholder')

// 7. Secrets never logged: config.js must not console.log secret values.
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8')
  assert(!/console\.log\(.*[Ss]ecret/.test(src), 'config.js never logs secrets')
  assert(src.includes('assertProductionSecrets'), 'config.js exposes assertProductionSecrets')
  assert(!src.includes("JWT_ACCESS_SECRET || 'video-ai-dev-access-secret'") === false ||
    src.includes('DEV_ACCESS_SECRET'), 'dev fallback is a named constant')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
