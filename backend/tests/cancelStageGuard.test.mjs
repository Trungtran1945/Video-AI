// Cancel invariant (Task 7): no new stage starts after cancellation.
// A project cancelled mid-pipeline must stop before the next stage —
// no executeStage call, no further job/project writes.
// Run: node backend/tests/cancelStageGuard.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { v4 as uuidv4 } from 'uuid'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-cancelguard-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = process.env.NODE_ENV || 'test'

const { initSchema } = await import('../src/db/schema.js')
const { insert, query, queryOne } = await import('../src/db/query.js')
const { createProjectWithAdmission } = await import('../src/services/projectAdmission.js')
const { cancelProjectUseCase } = await import('../src/usecases/cancelProjectUseCase.js')
const runner = await import('../src/pipeline/runner.js')
const { connection } = await import('../src/queue/connection.js')

await initSchema()
// No live Redis in tests: detach the eager ioredis socket (redisGuard pattern).
try { connection.disconnect() } catch (_) {}

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }
assert.deepEqual = (a, b, m) => {
  const same = JSON.stringify(a) === JSON.stringify(b)
  if (same) console.log('PASS:', m)
  else { failures++; console.error(`FAIL: ${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`) }
}

const user = { id: `cg-user-${Date.now()}`, email: `cg-${Date.now()}@test.local`, role: 'user', password: 'x' }
await insert('users', user)

const starts = []
let releaseStage1
const gate = new Promise((r) => { releaseStage1 = r })
runner.setStageImplOverride('summary.transcribe', async () => {
  starts.push('summary.transcribe')
  await gate
  return {}
})
runner.setStageImplOverride('summary.sceneDetect', async () => { starts.push('summary.sceneDetect'); return {} })

try {
  const admission = await createProjectWithAdmission({ id: uuidv4(), userId: user.id, mode: 'SUMMARY', title: 'Cancel guard', params: {}, copyrightAcknowledged: true })
  assert(admission.admitted, 'project được admit (pending)')
  const runPromise = runner.runPipeline(admission.project.id, null, admission.runToken)

  // chờ stage 1 thực sự bắt đầu
  await new Promise((r) => { const t = setInterval(() => { if (starts.includes('summary.transcribe')) { clearInterval(t); r() } }, 5) })

  // CANCEL giữa chừng (use case thật: 1 transaction + abort signal)
  const cancelled = await cancelProjectUseCase(admission.project.id)
  assert(cancelled.status === 'cancelled', 'project cancelled')

  releaseStage1()
  await Promise.race([runPromise, new Promise((r) => setTimeout(r, 5000))])
  await runPromise

  assert.deepEqual(starts, ['summary.transcribe'], `KHÔNG stage nào sau cancel (thực tế: ${JSON.stringify(starts)})`)
  const proj = await queryOne('SELECT * FROM projects WHERE id = ?', [admission.project.id])
  assert(proj.status === 'cancelled' && proj.run_token === null, 'project giữ cancelled, không bị ghi đè failed/completed')
  const jobs = await query(`SELECT type, status FROM generation_jobs WHERE project_id = ?`, [admission.project.id])
  const later = jobs.filter((j) => j.type !== 'summary.transcribe')
  assert(later.every((j) => j.status !== 'success' && j.status !== 'running'), 'không stage sau cancel ở trạng thái success/running')
  assert(jobs.find((j) => j.type === 'summary.sceneDetect')?.status === 'cancelled', 'stage 2 giữ cancelled từ cancel tx')
} finally {
  runner.clearStageImplOverrides()
}

try { connection.disconnect() } catch (_) {}
try {
  const { notifyQueue } = await import('../src/queue/notifyQueue.js')
  await notifyQueue.close().catch(() => {})
} catch (_) {}
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
await new Promise((r) => setTimeout(r, 100))
process.exit(failures === 0 ? 0 : 1)
