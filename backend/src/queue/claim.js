import { queryOne, runAffected, run } from '../db/query.js'
import { config } from '../config.js'

function nowIso() {
  return new Date().toISOString()
}

/**
 * claimQueuedProject — atomic single-winner claim of a queued project.
 *
 * Single SQL statement with status precondition:
 *   UPDATE projects SET status='pending', last_heartbeat_at=now
 *   WHERE id=? AND status='queued'
 * Only one worker can win (rows affected is 0 for losers, even across
 * processes). Callers MUST check `claimed` before calling runPipeline().
 *
 * Also enforces MAX_CONCURRENT_PROJECTS_PER_USER: after winning the claim,
 * counts the user's running projects; if over limit, rolls back to queued
 * and reports { claimed:false, reason:'concurrency' }.
 */
export async function claimQueuedProject(projectId) {
  const row = await queryOne('SELECT id, user_id, status FROM projects WHERE id = ?', [projectId])
  if (!row || row.status !== 'queued') return { claimed: false, reason: 'not-queued' }

  const affected = await runAffected(
    `UPDATE projects SET status = 'pending', last_heartbeat_at = ? WHERE id = ? AND status = 'queued'`,
    [nowIso(), projectId]
  )
  if (affected !== 1) return { claimed: false, reason: 'race-lost' }

  // Post-claim concurrency guard (per user, DB-counted so it works across
  // processes; activeRuns in-memory alone cannot do this).
  try {
    const maxConcurrent = config.maxConcurrentProjectsPerUser
    const running = await queryOne(
      `SELECT COUNT(*) as cnt FROM projects WHERE user_id = ? AND status = 'running'`,
      [row.user_id]
    )
    if ((running?.cnt || 0) >= maxConcurrent) {
      await run(`UPDATE projects SET status = 'queued' WHERE id = ? AND status = 'pending'`, [projectId])
      return { claimed: false, reason: 'concurrency' }
    }
  } catch (_) {}

  return { claimed: true, userId: row.user_id }
}

export default { claimQueuedProject }
