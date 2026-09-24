// Heartbeat stale detection + unified idempotent recovery.
// Uses an isolated temp data.db (never touches real data).
// Run: node backend/tests/heartbeatRecovery.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'video-ai-recovery-')), 'data.db')
process.env.NODE_ENV = process.env.NODE_ENV || 'test'

const { initSchema } = await import('../src/db/schema.js')
const { queryOne, insert } = await import('../src/db/query.js')
const { recoverStaleProjects } = await import('../src/pipeline/recovery.js')
const { touchHeartbeat } = await import('../src/pipeline/runner.js')

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const now = Date.now()
const oldIso = new Date(now - 60 * 60 * 1000).toISOString() // 1h ago (stale)
const freshIso = new Date(now - 60 * 1000).toISOString() // 1 minute ago (alive)

// running + old heartbeat -> stale; running + fresh heartbeat -> alive;
// running + active in-process run -> never touched; old created_date but
// fresh heartbeat -> NOT stale (created_date is not the age signal).
await insert('projects', { id: 'rec-stale', user_id: 'u1', mode: 'TRANSLATE_DUB', title: 'stale', status: 'running', created_date: oldIso, started_at: oldIso, last_heartbeat_at: oldIso })
await insert('projects', { id: 'rec-fresh', user_id: 'u1', mode: 'TRANSLATE_DUB', title: 'fresh', status: 'running', created_date: oldIso, started_at: oldIso, last_heartbeat_at: freshIso })
await insert('projects', { id: 'rec-active', user_id: 'u1', mode: 'TRANSLATE_DUB', title: 'active', status: 'running', created_date: oldIso, started_at: oldIso, last_heartbeat_at: oldIso })
await insert('projects', { id: 'rec-done', user_id: 'u1', mode: 'TRANSLATE_DUB', title: 'done', status: 'completed', created_date: oldIso })

// 1. Stale project is parked as queued exactly once.
const r1 = await recoverStaleProjects({
  timeoutMin: 10,
  nowMs: now,
  isActive: (id) => id === 'rec-active',
})
assert(r1.recoveredIds.includes('rec-stale'), 'stale project recovered')
assert(!r1.recoveredIds.includes('rec-fresh'), 'fresh-heartbeat pipeline NOT recovered')
assert(!r1.recoveredIds.includes('rec-active'), 'active pipeline NOT recovered')
assert(!r1.recoveredIds.includes('rec-done'), 'completed project NOT recovered')
assert(r1.skippedActive === 1, 'active run counted as skipped')

const staleAfter = await queryOne('SELECT status, recovery_reason FROM projects WHERE id = ?', ['rec-stale'])
assert(staleAfter.status === 'queued', 'stale project parked as queued')
assert(typeof staleAfter.recovery_reason === 'string' && staleAfter.recovery_reason.length > 0,
  'recovery reason recorded')
const freshAfter = await queryOne('SELECT status FROM projects WHERE id = ?', ['rec-fresh'])
assert(freshAfter.status === 'running', 'fresh pipeline stays running')

// 2. Restart recovery is idempotent: second run recovers nothing new.
// (rec-active stays guarded as live; everything else already settled.)
const r2 = await recoverStaleProjects({
  timeoutMin: 10,
  nowMs: now,
  isActive: (id) => id === 'rec-active',
})
assert(r2.recovered === 0, `second recovery recovers 0 (got ${r2.recovered})`)

// 3. touchHeartbeat keeps a running pipeline alive.
await touchHeartbeat('rec-fresh')
const hb = await queryOne('SELECT last_heartbeat_at FROM projects WHERE id = ?', ['rec-fresh'])
assert(hb.last_heartbeat_at && new Date(hb.last_heartbeat_at).getTime() > now - 60 * 1000,
  'touchHeartbeat refreshes last_heartbeat_at')

// 4. Implementation contract: heartbeat-based, shared, conditional.
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const recSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'recovery.js'), 'utf8')
  assert(recSrc.includes('last_heartbeat_at'), 'recovery uses last_heartbeat_at')
  assert(recSrc.includes('status = ?') && recSrc.includes('run_token = ?'), 'recovery UPDATE is conditional (idempotent)')
  assert(recSrc.includes('isPipelineRunning') || recSrc.includes('isActive'), 'recovery skips live runs')
  const drainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'queue', 'workers', 'drainQueued.js'), 'utf8')
  assert(drainSrc.includes('recoverStaleProjects'), 'drain uses shared recovery service')
  assert(!drainSrc.includes('created_date < ?'), 'drain no longer uses created_date as stale proxy')
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
  assert(serverSrc.includes('recoverStaleProjects'), 'server startup uses shared recovery service')
  const schemaSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.js'), 'utf8')
  assert(schemaSrc.includes('last_heartbeat_at'), 'schema has last_heartbeat_at')
  assert(schemaSrc.includes('started_at'), 'schema has started_at')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
