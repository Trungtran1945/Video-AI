import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_project_admission_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { query, queryOne, run } = await import('../src/db/query.js')
const { createProjectWithAdmission, claimQueuedProject, markProjectRunning, updateProjectOwned, acquireProjectRun, updateGenerationJobOwned, runProjectOwned, insertProjectOwned } = await import('../src/services/projectAdmission.js')

await initSchema()

let failures = 0
const assert = (condition, message) => {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

const baseProject = (index) => ({
  id: `admission-project-${index}`,
  user_id: 'admission-user',
  mode: 'SUMMARY',
  title: `project ${index}`,
  source_video_key: `video/${index}.mp4`,
  language: 'vi',
  style: 'cinematic',
  target_duration_sec: 60,
  aspect_ratio: '16:9',
  params: {},
})

const created = await Promise.all(
  Array.from({ length: 10 }, (_, index) => createProjectWithAdmission(baseProject(index), { maxConcurrent: 2 }))
)
const rows = await query('SELECT status FROM projects WHERE user_id = ?', ['admission-user'])
const pending = rows.filter((row) => row.status === 'pending').length
const queued = rows.filter((row) => row.status === 'queued').length
assert(created.length === 10, 'all concurrent create operations complete')
assert(pending === 2 && queued === 8, `max=2 reserves two slots and queues eight projects (got ${pending} pending, ${queued} queued)`)

const oldest = await queryOne('SELECT id FROM projects WHERE user_id = ? AND status = ? ORDER BY created_date ASC, rowid ASC LIMIT 1', ['admission-user', 'queued'])
const completed = await queryOne('SELECT id FROM projects WHERE user_id = ? AND status = ? LIMIT 1', ['admission-user', 'pending'])
await run('UPDATE projects SET status = ? WHERE id = ?', ['completed', completed.id])
const claim = await claimQueuedProject(oldest.id, { maxConcurrent: 2 })
const activeAfterClaim = await queryOne("SELECT COUNT(*) AS count FROM projects WHERE user_id = ? AND status IN ('pending', 'running')", ['admission-user'])
assert(claim.claimed === true, 'queued project is claimed when a slot is available')
assert(Number(activeAfterClaim.count) === 2, 'claim never exceeds the active limit')

const duplicate = await claimQueuedProject(oldest.id, { maxConcurrent: 2 })
assert(duplicate.claimed === false, 'the same queued project cannot be claimed twice')

const owned = await createProjectWithAdmission({
  id: 'owned-project',
  user_id: 'owned-user',
  mode: 'SUMMARY',
  title: 'owned',
}, { maxConcurrent: 1 })
const starts = await Promise.all([
  markProjectRunning(owned.project.id, owned.runToken),
  markProjectRunning(owned.project.id, owned.runToken),
])
assert(starts.filter(Boolean).length === 1, 'concurrent starts have one conditional owner')
assert((await updateProjectOwned(owned.project.id, owned.runToken, { progress: 10 })) === true, 'current owner can update its run')
assert((await updateProjectOwned(owned.project.id, owned.runToken, { target_duration_sec: 123 })) === true, 'current owner can update ingest metadata')
assert((await updateProjectOwned(owned.project.id, 'stale-token', { progress: 20 })) === false, 'stale owner cannot update the run')

await run('INSERT INTO projects (id, user_id, mode, title, status, run_token, lease_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
  'expired-pending', 'expired-user', 'SUMMARY', 'expired', 'pending', 'expired-token', '2000-01-01T00:00:00.000Z',
])
await run('INSERT INTO projects (id, user_id, mode, title, status) VALUES (?, ?, ?, ?, ?)', ['expired-running-no-lease', 'expired-user', 'SUMMARY', 'running', 'running'])
const expired = await acquireProjectRun('expired-pending', { maxConcurrent: 1 })
const expiredRow = await queryOne('SELECT status FROM projects WHERE id = ?', ['expired-pending'])
assert(expired.admitted === false && expired.reason === 'concurrency' && expiredRow.status === 'queued', 'expired pending reservation rechecks capacity before promotion')

await run('INSERT INTO projects (id, user_id, mode, title, status, run_token, lease_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
  'expired-running', 'expired-running-user', 'SUMMARY', 'running', 'running', 'expired-running-token', '2000-01-01T00:00:00.000Z',
])
const reclaimedRunning = await acquireProjectRun('expired-running', { maxConcurrent: 1, reclaimExpiredRunning: true })
const reclaimedRunningRow = await queryOne('SELECT status, run_token FROM projects WHERE id = ?', ['expired-running'])
assert(reclaimedRunning.admitted === true && reclaimedRunningRow.status === 'pending', 'expired running reservation can be reclaimed')
assert(reclaimedRunning.runToken && reclaimedRunning.runToken !== 'expired-running-token', 'reclaimed running reservation receives a new token')

await run('INSERT INTO projects (id, user_id, mode, title, status, run_token) VALUES (?, ?, ?, ?, ?, ?)', [
  'job-owner-project', 'job-owner-user', 'SUMMARY', 'job owner', 'running', 'job-owner-token',
])
await run('INSERT INTO generation_jobs (id, project_id, type, status) VALUES (?, ?, ?, ?)', ['job-owner-id', 'job-owner-project', 'summary.render', 'running'])
const ownedJobUpdate = await updateGenerationJobOwned('job-owner-project', 'job-owner-id', { status: 'success' }, 'job-owner-token')
assert(ownedJobUpdate === true, 'current run can update its generation job')
const ownedInsert = await insertProjectOwned('job-owner-project', 'job-owner-token', 'audios', { id: 'owned-audio', project_id: 'job-owner-project', kind: 'voice' })
assert(ownedInsert?.id === 'owned-audio', 'current run can insert owned artifacts')
await run('UPDATE projects SET status = ?, run_token = NULL WHERE id = ?', ['cancelled', 'job-owner-project'])
const staleJobUpdate = await updateGenerationJobOwned('job-owner-project', 'job-owner-id', { status: 'failed' }, 'job-owner-token')
const jobAfterCancel = await queryOne('SELECT status FROM generation_jobs WHERE id = ?', ['job-owner-id'])
assert(staleJobUpdate === false && jobAfterCancel.status === 'success', 'cancelled run cannot overwrite generation job state')
const staleInsert = await insertProjectOwned('job-owner-project', 'job-owner-token', 'audios', { id: 'stale-audio', project_id: 'job-owner-project', kind: 'voice' })
const audioCountAfterCancel = await queryOne('SELECT COUNT(*) AS count FROM audios WHERE project_id = ?', ['job-owner-project'])
assert(staleInsert === null && Number(audioCountAfterCancel.count) === 1, 'cancelled run cannot insert project artifacts')
const staleOwnedDelete = await runProjectOwned('job-owner-project', 'job-owner-token', 'DELETE FROM generation_jobs WHERE project_id = ?', ['job-owner-project'])
const jobAfterOwnedDelete = await queryOne('SELECT status FROM generation_jobs WHERE id = ?', ['job-owner-id'])
assert(staleOwnedDelete === false && jobAfterOwnedDelete.status === 'success', 'cancelled run cannot delete project artifacts')

await run('DELETE FROM projects WHERE user_id IN (?, ?, ?, ?, ?)', ['admission-user', 'owned-user', 'expired-user', 'expired-running-user', 'job-owner-user'])
fs.rmSync(process.env.DB_PATH, { force: true })

if (failures > 0) process.exit(1)
console.log('ALL PASS')
