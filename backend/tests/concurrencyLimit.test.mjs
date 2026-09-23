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
const claimSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'queue', 'claim.js'), 'utf8')

// 1. Single pipeline per project: in-process guard + distributed fresh-heartbeat guard.
assert(runnerSrc.includes('activeRuns.has(projectId)'), 'runner keeps in-process single-run guard')
assert(runnerSrc.includes('last_heartbeat_at'), 'runner checks DB heartbeat before take-over')
assert(runnerSrc.includes('owned by a live run'), 'runner refuses to double-start a live run')

// 2. Per-user cap enforced at the single choke point (covers create,
// regenerate, retry, redub, drain — not just one route).
assert(runnerSrc.includes('maxConcurrentProjectsPerUser'), 'runner enforces per-user cap')
assert(runnerSrc.includes("{ status: 'queued' }"), 'runner parks excess starts as queued')
assert(claimSrc.includes('maxConcurrentProjectsPerUser'), 'claim re-checks per-user cap after winning')

// 3. Drain still scopes by user with a slot check (no cross-user starvation).
assert(drainSrc.includes('GROUP BY user_id'), 'drain lists all queued users')
assert(drainSrc.includes("status = 'running'"), 'drain counts running per user')

// 4. No caller bypasses the guards with an unconditional status flip.
assert(!/UPDATE projects SET status = 'pending' WHERE id = \?`/.test(drainSrc),
  'drain has no unconditional pending flip')
assert(claimSrc.includes("AND status = 'queued'"), 'only conditional claim flips queued->pending')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
