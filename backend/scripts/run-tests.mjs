// Test runner: executes every backend/tests/*.test.mjs sequentially, fails fast on first failure.
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
  const r = spawnSync(process.execPath, [full], { stdio: 'inherit' })
  if (r.status !== 0) {
    failed.push(f)
    console.error(`FAIL: ${f} (exit ${r.status})`)
  }
}
if (failed.length) {
  console.error(`\n${failed.length} FAILURES: ${failed.join(', ')}`)
  process.exit(1)
}
console.log('\nALL TEST FILES PASS')
