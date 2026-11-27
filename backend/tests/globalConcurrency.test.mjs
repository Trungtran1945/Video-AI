// Global pipeline concurrency cap across users (prevents FFmpeg OOM under 10-100+ CCU).
// Run via test runner: cd backend && node scripts/run-tests.mjs globalConcurrency
import { v4 as uuidv4 } from 'uuid'

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.MAX_CONCURRENT_PROJECTS_PER_USER = '2'
process.env.MAX_GLOBAL_CONCURRENT_PIPELINES = '2'

const { initSchema } = await import('../src/db/schema.js')
const { queryOne, run } = await import('../src/db/query.js')
const { closePool } = await import('../src/db.js')
const {
  createProjectWithAdmission,
  claimQueuedProject,
  acquireProjectRun,
} = await import('../src/services/projectAdmission.js')

await initSchema()
await run("DELETE FROM projects WHERE id LIKE 'gcap-%'")

let failures = 0
const assert = (c, m) => {
  if (c) console.log('PASS:', m)
  else {
    failures++
    console.error('FAIL:', m)
  }
}

try {
  // User 1 & User 2 take the 2 global slots
  const p1 = await createProjectWithAdmission({
    id: `gcap-p1-${uuidv4().slice(0, 8)}`,
    userId: 'gcap-u1',
    mode: 'TRANSLATE_DUB',
    title: 'Global slot 1',
  })
  assert(p1.admitted === true && p1.project.status === 'pending', 'user 1 takes global slot 1')

  const p2 = await createProjectWithAdmission({
    id: `gcap-p2-${uuidv4().slice(0, 8)}`,
    userId: 'gcap-u2',
    mode: 'TRANSLATE_DUB',
    title: 'Global slot 2',
  })
  assert(p2.admitted === true && p2.project.status === 'pending', 'user 2 takes global slot 2')

  // User 3 has 0 active projects of their own, but global cap (2) is full -> queued
  const p3 = await createProjectWithAdmission({
    id: `gcap-p3-${uuidv4().slice(0, 8)}`,
    userId: 'gcap-u3',
    mode: 'TRANSLATE_DUB',
    title: 'Global queued 3',
  })
  assert(p3.admitted === false && p3.project.status === 'queued', 'user 3 queued when global cap reached')

  // claimQueuedProject respects global cap while 2 global slots are occupied
  const deniedClaim = await claimQueuedProject(p3.project.id)
  assert(deniedClaim.claimed === false && deniedClaim.reason === 'concurrency', 'claimQueuedProject denies while global cap full')

  // acquireProjectRun respects global cap and keeps project queued
  const deniedAcquire = await acquireProjectRun(p3.project.id)
  assert(deniedAcquire.admitted === false && deniedAcquire.reason === 'concurrency', 'acquireProjectRun denies while global cap full')

  // Free 1 global slot -> user 3 can now claim
  await run("UPDATE projects SET status = 'completed', run_token = NULL WHERE id = ?", [p1.project.id])
  const grantedClaim = await claimQueuedProject(p3.project.id)
  assert(grantedClaim.claimed === true && grantedClaim.project.status === 'pending', 'user 3 claims freed global slot')

  const dbP3 = await queryOne('SELECT status, run_token FROM projects WHERE id = ?', [p3.project.id])
  assert(dbP3?.status === 'pending' && Boolean(dbP3?.run_token), 'claimed project has pending status and run_token')
} finally {
  await run("DELETE FROM projects WHERE id LIKE 'gcap-%'").catch(() => {})
  await closePool().catch(() => {})
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
