// CI gate: backend tests must run and failures must fail the job;
// lint failures must not be masked. Run: node backend/tests/ciGate.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ci = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))

// 1. Backend tests execute in CI and fail the job on failure.
assert(/cd backend && npm test/.test(ci), 'CI runs `cd backend && npm test`')
assert(!/\|\| echo/.test(ci), 'CI masks no failures with `|| echo`')
assert(!/2>\/dev\/null/.test(ci), 'CI does not silence stderr to hide failures')

// 2. Backend has a real lint script (not a masked no-op).
assert(typeof pkg.scripts?.lint === 'string' && pkg.scripts.lint.length > 0,
  'backend package.json has a lint script')
assert(!/echo "No lint/.test(ci), 'CI does not echo away missing lint')

// 3. Frontend gates intact.
assert(/cd frontend && npm run lint/.test(ci), 'CI still lints frontend')
assert(/cd frontend && npm run typecheck/.test(ci), 'CI still typechecks frontend')
assert(/cd frontend && npm run build/.test(ci), 'CI still builds frontend')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
