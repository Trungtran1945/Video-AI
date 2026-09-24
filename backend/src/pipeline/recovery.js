import { query, withTransaction } from '../db/query.js'
import { isPipelineRunning } from './runner.js'
import { config } from '../config.js'

export const RECOVERY_REASON_RESTART = 'Pipeline interrupted — server restarted, queued for resume'
export const RECOVERY_REASON_STALE = 'Pipeline stale (heartbeat timeout) — queued for resume'

function cutoffIso(timeoutMin, nowMs) {
  return new Date(nowMs - timeoutMin * 60 * 1000).toISOString()
}

function heartbeatOf(project) {
  return project.last_heartbeat_at || project.started_at || null
}

export async function recoverStaleProjects({
  timeoutMin = config.recoveryStaleMinutes,
  nowMs = Date.now(),
  reason = RECOVERY_REASON_STALE,
  isActive = isPipelineRunning,
} = {}) {
  const cutoff = cutoffIso(timeoutMin, nowMs)
  const force = timeoutMin === 0
  const candidates = await query(
    `SELECT id, title, user_id, created_date, started_at, last_heartbeat_at, lease_expires_at,
            run_token, status
     FROM projects WHERE status = 'running' OR status = 'pending'`
  )
  let recovered = 0
  let skippedActive = 0
  const recoveredIds = []

  for (const project of candidates) {
    try {
      if (isActive(project.id)) {
        skippedActive += 1
        continue
      }
    } catch (_) {}

    const leaseFresh = project.lease_expires_at && new Date(project.lease_expires_at).getTime() > nowMs
    const ageReference = heartbeatOf(project) || project.created_date
    if (!force && leaseFresh) continue
    if (!force && ageReference && ageReference >= cutoff) continue

    const reasonText = project.status === 'pending'
      ? `${reason} (pending lease expired)`
      : `${reason} (last activity: ${ageReference || 'unknown'})`
    const changed = await withTransaction(async (tx) => {
      const tokenPredicate = project.run_token ? 'AND run_token = ?' : 'AND run_token IS NULL'
      const affected = await tx.runAffected(
        `UPDATE projects SET status = ?, run_token = ?, lease_expires_at = NULL, recovery_reason = ?
         WHERE id = ? AND status = ? ${tokenPredicate}`,
        project.status === 'pending'
          ? ['queued', null, reasonText, project.id, 'pending', ...(project.run_token ? [project.run_token] : [])]
          : ['queued', null, reasonText, project.id, 'running', ...(project.run_token ? [project.run_token] : [])]
      )
      if (affected !== 1) return false
      await tx.run(
        `UPDATE generation_jobs SET status = 'pending', step = 'queued', error_message = ?
         WHERE project_id = ? AND status IN ('running', 'pending')`,
        [reason, project.id]
      )
      return true
    }, { op: 'project.recovery' })
    if (!changed) continue
    recovered += 1
    recoveredIds.push(project.id)
  }

  return { recovered, skippedActive, recoveredIds }
}

export default { recoverStaleProjects, RECOVERY_REASON_RESTART, RECOVERY_REASON_STALE }
