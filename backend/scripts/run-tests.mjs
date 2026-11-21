// Test runner: executes backend/tests/*.test.mjs sequentially against PostgreSQL (video_ai_test)
// Run: npm test (from backend/)
import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureTestDatabase, cleanTestDatabase } from './setup-test-db.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const testsDir = path.join(__dirname, '..', 'tests')
let files = fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.mjs')).sort()

// Allow filtering tests via cli args: node scripts/run-tests.mjs <filter>
const filterArg = process.argv.slice(2).find((a) => !a.startsWith('-'))
if (filterArg) {
  files = files.filter((f) => f.toLowerCase().includes(filterArg.toLowerCase()))
  console.log(`Filtered to ${files.length} test files matching "${filterArg}"`)
}

const defaultTestDbUrl = process.env.TEST_DATABASE_URL ||
  (process.env.DATABASE_URL
    ? process.env.DATABASE_URL.replace(/\/[^/?]+(\?.*)?$/, '/video_ai_test$1')
    : 'postgresql://video_ai_user:video_ai_pass@localhost:5433/video_ai_test')

const testDbUrl = defaultTestDbUrl
await ensureTestDatabase(testDbUrl)

console.log(`Running ${files.length} test files against ${testDbUrl}...`)
let failed = []
for (const f of files) {
  await cleanTestDatabase(testDbUrl)
  const full = path.join(testsDir, f)
  console.log(`\n=== ${f} ===`)
  const r = spawnSync(process.execPath, [full], {
    stdio: 'inherit',
    timeout: 60000,
    killSignal: 'SIGKILL',
    env: { ...process.env, DATABASE_URL: testDbUrl, RUN_TESTS_RUNNER: '1' },
  })
  if (r.error && r.error.code === 'ETIMEDOUT') {
    failed.push(f)
    console.error(`FAIL: ${f} (timed out after 45s)`)
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::error file=backend/tests/${f},title=Test Timeout::${f} timed out after 45s`)
    }
  } else if (r.status !== 0) {
    failed.push(f)
    console.error(`FAIL: ${f} (exit ${r.status})`)
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::error file=backend/tests/${f},title=Test Failed::${f} exited with code ${r.status}`)
    }
  }
}
if (failed.length) {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::error title=Failed Tests::${failed.length} test files failed: ${failed.join(', ')}`)
  }
  console.error(`\n${failed.length} FAILURES: ${failed.join(', ')}`)
  process.exit(1)
}
console.log('\nALL TEST FILES PASS')
