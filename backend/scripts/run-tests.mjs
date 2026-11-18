// Test runner: executes every backend/tests/*.test.mjs sequentially, runs ALL
// files and aggregates failures (exit 1 if any file failed — never masked).
// Run: npm test (from backend/)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const testsDir = path.join(__dirname, '..', 'tests')
const files = fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.mjs')).sort()

console.log(`Running ${files.length} test files...`)
let failed = []
for (const f of files) {
  const full = path.join(testsDir, f)
  console.log(`\n=== ${f} ===`)
  const r = spawnSync(process.execPath, [full], {
    stdio: 'inherit',
    timeout: 45000,
    killSignal: 'SIGKILL',
    env: { ...process.env, RUN_TESTS_RUNNER: '1' },
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
