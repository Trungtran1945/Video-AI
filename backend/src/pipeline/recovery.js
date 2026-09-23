import { query, runAffected, run } from '../db/query.js'
import { isPipelineRunning } from './runner.js'
import { config } from '../config.js'

export const RECOVERY_REASON_RESTART = 'Pipeline interrupted — server restarted, queued for resume'
export const RECOVERY_REASON_STALE = 'Pipeline stale (heartbeat timeout) — queued for resume'

function cutoffIso(timeoutMin, nowMs) {
  return new Date(nowMs - timeoutMin * 60 * 1000).toISOString()
}

function heartbeatOf(p) {
  return p.last_heartbeat_at || p.started_at || null
}

/**
 * recoverStaleProjects — the single shared recovery implementation.
 * Used by both server.js startup and the periodic drain worker.
 *
 * Rules:
 * - Only status='running' candidates.
 * - Stale only when heartbeat (last_heartbeat_at → started_at) is older
 *   than timeoutMin. Legacy rows with neither timestamp fall back to
 *   created_date so old DBs still recover.
 * - Never touches projects with a live in-process run (isPipelineRunning).
 * - Conditional UPDATE (WHERE status='running') makes restarts idempotent:
 *   the second restart affects 0 rows.
 * - Preserves artifacts; parks generation_jobs running/pending → pending/queued.
 */
export async function recoverStaleProjects({
  timeoutMin = config.recoveryStaleMinutes,
  nowMs = Date.now(),
  reason = RECOVERY_REASON_STALE,
  isActive = isPipelineRunning,
} = {}) {
  const cutoff = cutoffIso(timeoutMin, nowMs)
  const candidates = await query(
    `SELECT id, title, user_id, created_date, started_at, last_heartbeat_at, status
     FROM projects WHERE status = 'running'`
  )
  let recovered = 0
  let skippedActive = 0
  const recoveredIds = []

  for (const p of candidates) {
    try {
      if (isActive(p.id)) {
        skippedActive++
        continue
      }
    } catch (_) {}

    const hb = heartbeatOf(p)
    // No heartbeat at all (legacy DB): fall back to created_date so a
    // project stuck since before the heartbeat migration still recovers.
    const ageRef = hb || p.created_date
    if (ageRef && ageRef >= cutoff) continue // fresh heartbeat → not stale

    const affected = await runAffected(
      `UPDATE projects SET status = 'queued', recovery_reason = ? WHERE id = ? AND status = 'running'`,
      [`${reason} (last activity: ${ageRef || 'unknown'})`, p.id]
    )
    if (affected !== 1) continue // lost race with another recoverer → idempotent
    await run(
      `UPDATE generation_jobs SET status = 'pending', step = 'queued', error_message = ?
       WHERE project_id = ? AND status IN ('running', 'pending')`,
      [reason, p.id]
    )
    recovered++
    recoveredIds.push(p.id)
  }

  return { recovered, skippedActive, recoveredIds }
}

export default { recoverStaleProjects, RECOVERY_REASON_RESTART, RECOVERY_REASON_STALE }
