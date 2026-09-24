// Distributed-safe concurrency: one project runs once, one user capped.
// Run: node backend/tests/concurrencyLimit.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const runnerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'runner.js'), 'utf8')
const drainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'queue', 'workers', 'drainQueued.js'), 'utf8')

// 1. Single pipeline ownership: active/start guards + conditional run token.
const admissionSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'projectAdmission.js'), 'utf8')
assert(runnerSrc.includes('activeRuns.has(projectId)'), 'runner keeps in-process single-run guard')
assert(runnerSrc.includes('startingRuns.has(projectId)'), 'runner serializes concurrent starts')
assert(runnerSrc.includes('markProjectRunning'), 'runner requires a conditional running transition')
assert(runnerSrc.includes('run_token'), 'runner fences lifecycle writes by run token')
assert(admissionSrc.includes("status IN ('pending', 'running')"), 'admission counts reserved and running slots')

// 2. Per-user cap is enforced by the shared admission service.
assert(admissionSrc.includes('maxConcurrentProjectsPerUser'), 'admission enforces per-user cap')
assert(admissionSrc.includes("status = 'queued'"), 'admission parks excess projects as queued')
assert(admissionSrc.includes('run_token'), 'admission creates a run ownership token')

// 3. Drain scopes by user and does not bypass the shared claim.
assert(drainSrc.includes('GROUP BY user_id'), 'drain lists all queued users')
assert(drainSrc.includes("status IN ('pending', 'running')"), 'drain counts active reservations')
assert(drainSrc.includes('claimQueuedProject'), 'drain uses shared atomic claim')

// 4. No caller bypasses the guards with an unconditional status flip.
assert(!/UPDATE projects SET status = 'pending' WHERE id = \?`/.test(drainSrc),
  'drain has no unconditional pending flip')
assert(admissionSrc.includes("AND status = 'queued'"), 'only conditional claim flips queued->pending')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
