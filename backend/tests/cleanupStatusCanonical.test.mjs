// Retention cleanup canonical statuses (Issues A+B):
// - expired COMPLETED + FAILED (+ legacy 'success' compat) are cleaned
// - RUNNING / PENDING / QUEUED / CANCELLED are never touched
// - filesystem failure retains expires_at (retry signal), cleaned stays 0
// - retry after repair succeeds and clears expires_at
// - canonical constants are the single source of truth
// Run: node backend/tests/cleanupStatusCanonical.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-cleanup-status-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'
process.env.PROJECT_RETENTION_DAYS = '30'

const { initSchema } = await import('../src/db/schema.js')
const { insert, queryOne, run } = await import('../src/db/query.js')
const { processCleanup } = await import('../src/queue/workers/cleanupWorker.js')
const {
  PROJECT_STATUS,
  PROJECT_RETAINABLE_STATUSES,
  normalizeProjectStatus,
} = await import('../src/lib/projectStatus.js')
const { connection } = await import('../src/queue/connection.js')

await initSchema()
try { connection.disconnect() } catch (_) {}

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// ── 0) canonical constants ──
assert(PROJECT_STATUS.COMPLETED === 'completed', 'canonical COMPLETED=completed')
assert(!Object.values(PROJECT_STATUS).includes('success'), 'canonical has no success')
assert(normalizeProjectStatus('success') === 'completed', 'legacy success normalizes to completed')
assert(PROJECT_RETAINABLE_STATUSES.includes('completed') && PROJECT_RETAINABLE_STATUSES.includes('failed'),
  'retainable = completed+failed')
assert(!PROJECT_RETAINABLE_STATUSES.includes('cancelled'), 'cancelled excluded from retention (policy 1.A)')
assert(!PROJECT_RETAINABLE_STATUSES.includes('running'), 'running never retainable')

const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
const mk = async (id, status) => {
  await insert('projects', { id, user_id: 'clstat-u', mode: 'SUMMARY', title: id, status, expires_at: old })
  const dir = path.join(process.env.STORAGE_DIR, 'projects', id, 'tmp')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x')
}
await insert('users', { id: 'clstat-u', email: 'clstat@test.local', password: 'x', role: 'user', name: '' })
for (const s of ['completed', 'failed', 'success', 'running', 'pending', 'queued', 'cancelled']) {
  await mk(`clstat-${s}`, s)
}

// ── 1) sweep: completed/failed/success cleaned; actives untouched ──
const r1 = await processCleanup({})
assert(r1.cleaned === 3, `expired completed+failed+success cleaned (got ${r1.cleaned})`)
for (const s of ['completed', 'failed', 'success']) {
  const row = await queryOne('SELECT expires_at FROM projects WHERE id = ?', [`clstat-${s}`])
  assert(row && row.expires_at == null, `${s} expires_at cleared after success`)
}
for (const s of ['running', 'pending', 'queued', 'cancelled']) {
  const row = await queryOne('SELECT expires_at FROM projects WHERE id = ?', [`clstat-${s}`])
  assert(row && row.expires_at === old, `${s} untouched (expires_at retained)`)
}

// ── 2) failure retains retry signal ──
await insert('projects', {
  id: 'clstat-fail', user_id: 'clstat-u', mode: 'SUMMARY', title: 'fail',
  status: 'completed', expires_at: old,
})
{
  const dir = path.join(process.env.STORAGE_DIR, 'projects', 'clstat-fail', 'tmp')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'y.txt'), 'y')
}
const origRm = fs.rmSync
fs.rmSync = () => { const e = new Error('EBUSY: simulated'); e.code = 'EBUSY'; throw e }
let r2
try {
  r2 = await processCleanup({})
} finally {
  fs.rmSync = origRm
}
assert(r2.cleaned === 0, `failure cleans nothing (got ${r2.cleaned})`)
assert((r2.failed || []).includes('clstat-fail'), 'failed project reported in result.failed')
{
  const row = await queryOne('SELECT expires_at, next_cleanup_attempt_at FROM projects WHERE id = ?', ['clstat-fail'])
  assert(row && row.expires_at === old, 'failure RETAINS expires_at (retry signal kept)')
  assert(row && row.next_cleanup_attempt_at && new Date(row.next_cleanup_attempt_at).getTime() > Date.now(),
    'failure sets future next_cleanup_attempt_at backoff')
}

// ── 3) retry after repair succeeds ──
await run(`UPDATE projects SET next_cleanup_attempt_at = ? WHERE id = ?`,
  [new Date(Date.now() - 1000).toISOString(), 'clstat-fail'])
const r3 = await processCleanup({})
assert(r3.cleaned >= 1, `retry after repair cleans (got ${r3.cleaned})`)
{
  const row = await queryOne('SELECT expires_at FROM projects WHERE id = ?', ['clstat-fail'])
  assert(row && row.expires_at == null, 'retry success clears expires_at')
}

// cleanup
await run(`DELETE FROM projects WHERE user_id = ?`, ['clstat-u'])
await run(`DELETE FROM users WHERE id = ?`, ['clstat-u'])
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
process.exit(failures === 0 ? 0 : 1)
