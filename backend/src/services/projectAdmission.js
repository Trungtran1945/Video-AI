import { v4 as uuidv4 } from 'uuid'
import { config } from '../config.js'
import { withTransaction, queryOne, updateById, insert, run } from '../db/query.js'

const ACTIVE_STATUSES = ['pending', 'running']
const DEFAULT_LEASE_SECONDS = 1800

function limitFrom(options) {
  const value = Number(options?.maxConcurrent ?? config.maxConcurrentProjectsPerUser)
  return Number.isInteger(value) && value > 0 ? value : 2
}

function leaseExpiry(now = Date.now()) {
  return new Date(now + (Number(config.projectLeaseSeconds) || DEFAULT_LEASE_SECONDS) * 1000).toISOString()
}

function projectValues(data, status, runToken) {
  const now = new Date().toISOString()
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + Number(config.projectRetentionDays || 30))
  return {
    id: data.id || uuidv4(),
    user_id: data.userId || data.user_id,
    mode: data.mode,
    title: data.title,
    status,
    language: data.language || 'vi',
    style: data.style || null,
    target_duration_sec: Number(data.targetDurationSec ?? data.target_duration_sec ?? 60),
    aspect_ratio: data.aspectRatio || data.aspect_ratio || '16:9',
    params: typeof data.params === 'string' ? data.params : JSON.stringify(data.params || {}),
    source_video_key: data.sourceVideoKey || data.source_video_key || null,
    template_video_key: null,
    copyright_acknowledged: data.copyrightAcknowledged === false ? 0 : 1,
    copyright_ack_at: now,
    expires_at: expiresAt.toISOString(),
    video_hash: data.videoHash || data.video_hash || null,
    run_token: runToken,
    lease_expires_at: runToken ? leaseExpiry() : null,
    started_at: null,
    last_heartbeat_at: runToken ? now : null,
  }
}

export async function createProjectWithAdmission(data, options = {}) {
  const maxConcurrent = limitFrom(options)
  return withTransaction(async (tx) => {
    const active = await tx.queryOne(
      `SELECT COUNT(*) AS count FROM projects WHERE user_id = ? AND status IN ('pending', 'running')`,
      [data.userId || data.user_id]
    )
    const runToken = Number(active?.count || 0) < maxConcurrent ? uuidv4() : null
    const status = runToken ? 'pending' : 'queued'
    const project = await tx.insert('projects', projectValues(data, status, runToken))
    return { project, admitted: Boolean(runToken), runToken }
  }, { op: 'project.admit.create' })
}

export async function claimQueuedProject(projectId, options = {}) {
  const maxConcurrent = limitFrom(options)
  return withTransaction(async (tx) => {
    const project = await tx.queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
    if (!project || project.status !== 'queued') return { claimed: false, reason: 'not-queued' }
    const active = await tx.queryOne(
      `SELECT COUNT(*) AS count FROM projects WHERE user_id = ? AND status IN ('pending', 'running')`,
      [project.user_id]
    )
    if (Number(active?.count || 0) >= maxConcurrent) return { claimed: false, reason: 'concurrency' }
    const token = uuidv4()
    const now = new Date().toISOString()
    const changed = await tx.runAffected(
      `UPDATE projects SET status = 'pending', run_token = ?, lease_expires_at = ?,
       started_at = NULL, last_heartbeat_at = ?, recovery_reason = NULL
       WHERE id = ? AND status = 'queued'`,
      [token, leaseExpiry(), now, projectId]
    )
    if (changed !== 1) return { claimed: false, reason: 'race-lost' }
    const claimed = await tx.queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
    return { claimed: true, project: claimed, runToken: token, userId: project.user_id }
  }, { op: 'project.admit.claim' })
}

function leaseIsFresh(project, now = Date.now()) {
  if (!project?.lease_expires_at) return false
  return new Date(project.lease_expires_at).getTime() > now
}

export async function acquireProjectRun(projectId, options = {}) {
  const maxConcurrent = limitFrom(options)
  const allowedStatuses = new Set(options.allowedStatuses || ['queued', 'pending', 'completed', 'failed', 'cancelled'])
  return withTransaction(async (tx) => {
    let project = await tx.queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
    if (!project) return { admitted: false, reason: 'not-found' }
    if (project.status === 'running') {
      if (!options.reclaimExpiredRunning || leaseIsFresh(project)) {
        return { admitted: false, reason: 'running', project }
      }
      const tokenPredicate = project.run_token ? 'AND run_token = ?' : 'AND run_token IS NULL'
      const reclaimed = await tx.runAffected(
        `UPDATE projects SET status = 'queued', run_token = NULL, lease_expires_at = NULL,
         recovery_reason = 'expired running lease reclaimed' WHERE id = ? AND status = 'running' ${tokenPredicate}`,
        [projectId, ...(project.run_token ? [project.run_token] : [])]
      )
      if (reclaimed !== 1) return { admitted: false, reason: 'race-lost' }
      project = { ...project, status: 'queued', run_token: null, lease_expires_at: null }
    }
    if (project.status === 'pending' && leaseIsFresh(project)) {
      if (options.allowReserved) {
        return { admitted: true, existing: true, project, runToken: project.run_token }
      }
      return { admitted: false, reason: 'already-reserved', project, runToken: project.run_token }
    }
    if (project.status !== 'queued' && !allowedStatuses.has(project.status)) {
      return { admitted: false, reason: 'invalid-status', project }
    }
    if (project.status === 'pending' && !leaseIsFresh(project)) {
      const expired = await tx.runAffected(
        `UPDATE projects SET status = 'queued', run_token = NULL, lease_expires_at = NULL WHERE id = ? AND status = 'pending'`,
        [projectId]
      )
      if (expired !== 1) return { admitted: false, reason: 'race-lost' }
    }

    const active = await tx.queryOne(
      `SELECT COUNT(*) AS count FROM projects WHERE user_id = ? AND status IN ('pending', 'running')`,
      [project.user_id]
    )
    if (Number(active?.count || 0) >= maxConcurrent) {
      if (project.status !== 'queued') {
        await tx.run(`UPDATE projects SET status = 'queued', run_token = NULL, lease_expires_at = NULL WHERE id = ?`, [projectId])
      }
      return { admitted: false, reason: 'concurrency' }
    }
    const token = uuidv4()
    const now = new Date().toISOString()
    const changed = await tx.runAffected(
      `UPDATE projects SET status = 'pending', run_token = ?, lease_expires_at = ?, started_at = NULL,
       last_heartbeat_at = ?, recovery_reason = NULL WHERE id = ?`,
      [token, leaseExpiry(), now, projectId]
    )
    if (changed !== 1) return { admitted: false, reason: 'race-lost' }
    const admitted = await tx.queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
    return { admitted: true, project: admitted, runToken: token }
  }, { op: 'project.admit.acquire' })
}

export async function markProjectRunning(projectId, runToken) {
  return withTransaction(async (tx) => {
    const now = new Date().toISOString()
    const changed = await tx.runAffected(
      `UPDATE projects SET status = 'running', progress = 0, started_at = ?, last_heartbeat_at = ?, lease_expires_at = ?
       WHERE id = ? AND status = 'pending' AND run_token = ?`,
      [now, now, leaseExpiry(), projectId, runToken]
    )
    if (changed !== 1) return false
    return true
  }, { op: 'project.run.start' })
}

export async function updateProjectOwned(projectId, runToken, fields) {
  const allowed = new Set(['status', 'progress', 'last_heartbeat_at', 'lease_expires_at', 'recovery_reason', 'run_token', 'target_duration_sec'])
  const entries = Object.entries(fields || {}).filter(([key]) => allowed.has(key))
  if (!entries.length) return false
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ')
  const values = entries.map(([, value]) => value)
  return withTransaction(async (tx) => {
    const changed = await tx.runAffected(
      `UPDATE projects SET ${assignments} WHERE id = ? AND run_token = ?`,
      [...values, projectId, runToken]
    )
    return changed === 1
  }, { op: 'project.run.update' })
}

export async function updateGenerationJobOwned(projectId, jobId, fields, runToken) {
  if (!runToken) return updateById('generation_jobs', jobId, fields)
  const allowed = new Set([
    'status', 'step', 'progress', 'error_message', 'next_retry_at', 'attempts', 'result', 'payload', 'cancelled_at',
  ])
  const entries = Object.entries(fields || {}).filter(([key]) => allowed.has(key))
  if (!entries.length) return true
  return withTransaction(async (tx) => {
    const project = await tx.queryOne('SELECT status, run_token FROM projects WHERE id = ?', [projectId])
    if (!project || project.status !== 'running' || project.run_token !== runToken) return false
    const assignments = entries.map(([key]) => `${key} = ?`).join(', ')
    const changed = await tx.runAffected(
      `UPDATE generation_jobs SET ${assignments} WHERE id = ? AND project_id = ?`,
      [...entries.map(([, value]) => value), jobId, projectId]
    )
    return changed === 1
  }, { op: 'generation_job.run.update' })
}

export async function insertProjectOwned(projectId, runToken, table, values) {
  if (!runToken) return insert(table, values)
  return withTransaction(async (tx) => {
    const project = await tx.queryOne('SELECT status, run_token FROM projects WHERE id = ?', [projectId])
    if (!project || project.status !== 'running' || project.run_token !== runToken) return null
    return tx.insert(table, values)
  }, { op: 'project.run.insert' })
}

export async function runProjectOwned(projectId, runToken, sql, params = []) {
  if (!runToken) return run(sql, params)
  return withTransaction(async (tx) => {
    const project = await tx.queryOne('SELECT status, run_token FROM projects WHERE id = ?', [projectId])
    if (!project || project.status !== 'running' || project.run_token !== runToken) return false
    await tx.run(sql, params)
    return true
  }, { op: 'project.run.sql' })
}

export async function touchProjectLease(projectId, runToken) {
  return updateProjectOwned(projectId, runToken, {
    last_heartbeat_at: new Date().toISOString(),
    lease_expires_at: leaseExpiry(),
  })
}

export async function isProjectRunOwned(projectId, runToken) {
  if (!runToken) return false
  const project = await queryOne('SELECT status, run_token FROM projects WHERE id = ?', [projectId])
  return project?.status === 'running' && project.run_token === runToken
}

export async function getProjectRun(projectId) {
  return queryOne('SELECT id, status, run_token, lease_expires_at FROM projects WHERE id = ?', [projectId])
}

export const PROJECT_ACTIVE_STATUSES = ACTIVE_STATUSES

export default {
  createProjectWithAdmission,
  claimQueuedProject,
  acquireProjectRun,
  markProjectRunning,
  updateProjectOwned,
  updateGenerationJobOwned,
  insertProjectOwned,
  runProjectOwned,
  touchProjectLease,
  isProjectRunOwned,
  getProjectRun,
  PROJECT_ACTIVE_STATUSES,
}
