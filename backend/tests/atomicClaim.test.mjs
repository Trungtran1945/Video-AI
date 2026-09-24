// Atomic queue claim: two workers cannot claim the same queued project.
// Functional test uses an isolated temp data.db (never touches real data).
// Run: node backend/tests/atomicClaim.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'video-ai-claim-')), 'data.db')
process.env.NODE_ENV = process.env.NODE_ENV || 'test'

const { initSchema } = await import('../src/db/schema.js')
const { queryOne, insert } = await import('../src/db/query.js')
const { claimQueuedProject } = await import('../src/queue/claim.js')

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// Seed a queued project.
const p = await insert('projects', {
  id: 'claim-p1',
  user_id: 'claim-u1',
  mode: 'TRANSLATE_DUB',
  title: 'claim test',
  status: 'queued',
})

// 1. First claim wins.
const first = await claimQueuedProject(p.id)
assert(first.claimed === true, 'first claim wins')

// 2. Second claim on the same project loses (no double-processing).
const second = await claimQueuedProject(p.id)
assert(second.claimed === false, 'duplicate claim loses')
assert(second.reason === 'not-queued' || second.reason === 'race-lost',
  `duplicate claim reports reason (got ${second.reason})`)

// 3. Project is now pending (owned), not queued.
const after = await queryOne('SELECT status FROM projects WHERE id = ?', [p.id])
assert(after.status === 'pending', `claimed project is pending (got ${after.status})`)

// 4. Claim on non-queued status refuses without side effects.
const third = await claimQueuedProject(p.id)
assert(third.claimed === false, 'claim on pending project refuses')

// 5. Concurrency guard: user at MAX running cannot claim another.
await insert('projects', { id: 'claim-run1', user_id: 'claim-u2', mode: 'TRANSLATE_DUB', title: 'r1', status: 'running' })
await insert('projects', { id: 'claim-run2', user_id: 'claim-u2', mode: 'TRANSLATE_DUB', title: 'r2', status: 'running' })
await insert('projects', { id: 'claim-q2', user_id: 'claim-u2', mode: 'TRANSLATE_DUB', title: 'q2', status: 'queued' })
const over = await claimQueuedProject('claim-q2')
assert(over.claimed === false && over.reason === 'concurrency', 'user at max concurrency cannot claim')
const parked = await queryOne('SELECT status FROM projects WHERE id = ?', ['claim-q2'])
assert(parked.status === 'queued', 'over-limit claim rolls back to queued')

// 6. Implementation contract: conditional UPDATE + rows-affected check.
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const admissionSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'projectAdmission.js'), 'utf8')
  assert(admissionSrc.includes("AND status = 'queued'"), 'claim UPDATE is conditional on queued')
  assert(admissionSrc.includes('tx.runAffected'), 'claim checks rows affected')
  const drainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'queue', 'workers', 'drainQueued.js'), 'utf8')
  assert(drainSrc.includes('claimQueuedProject'), 'drain uses claimQueuedProject helper')
  assert(!/UPDATE projects SET status = 'pending' WHERE id = \?`/.test(drainSrc),
    'drain has no unconditional pending UPDATE')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
