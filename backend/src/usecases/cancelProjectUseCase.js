import { queryOne, withTransaction } from '../db/query.js'
import { projectDir, tmpDirOf } from '../pipeline/context.js'
import fs from 'node:fs'
import { abortPipeline } from '../pipeline/runner.js'
import { safeAddNotify } from '../queue/notifyQueue.js'

/**
 * CancelProjectUseCase — FR-J1
 * Cancel all PENDING/RUNNING jobs for a project, set status to 'cancelled',
 * clean up temp files. Idempotent: calling on finished project returns current status.
 *
 * Commit boundary: the project + job status updates commit as ONE transaction.
 * Everything after the commit (abort, fs cleanup, notification) is a post-commit
 * side effect — it may fail, but it can never flip an already-committed
 * cancellation into an API failure. `deps` exists so tests can inject failing
 * side effects.
 */
export async function cancelProjectUseCase(projectId, deps = {}) {
  const abort = deps.abort || abortPipeline
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
  if (!project) throw new Error('Project not found')

  // Idempotent: already finished
  if (['completed', 'failed', 'cancelled'].includes(project.status)) {
    return project
  }

  const now = new Date().toISOString()

  // One atomic commit: project status + job cancellations succeed or fail together.
  await withTransaction(async (tx) => {
    await tx.run(
      `UPDATE projects SET status = 'cancelled', cancelled_at = ?, run_token = NULL, lease_expires_at = NULL
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [now, projectId]
    )
    await tx.run(
      `UPDATE generation_jobs SET status = 'cancelled', cancelled_at = ?, step = 'cancelled'
       WHERE project_id = ? AND status IN ('pending', 'running')`,
      [now, projectId]
    )
  }, { op: 'project.cancel' })

  // ── Post-commit side effects: best-effort, never fail the request ──
  // Abort any running pipeline stages
  try {
    abort(projectId)
  } catch (abortErr) {
    console.error('[CancelProject] abort failed after commit:', abortErr?.message || abortErr)
  }

  // Clean up temp files in storage/tmp/{projectId}
  const projectStorageDir = projectDir(projectId)
  const temporaryDir = tmpDirOf(projectId)
  for (const dir of [projectStorageDir, temporaryDir]) {
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    } catch (_) {}
  }

  // Send notification on cancel (isolated — never fail cancel when Redis is down)
  try {
    const user = await queryOne('SELECT email FROM users WHERE id = ?', [project.user_id])
    if (user?.email) {
      await safeAddNotify('projectDone', {
        projectId,
        projectTitle: project.title,
        userEmail: user.email,
        status: 'cancelled',
        mode: project.mode,
      })
    }
  } catch (notifyErr) {
    console.error('[CancelProject] Notification failed:', notifyErr.message)
  }

  // Return updated project. The read happens after commit — if it somehow
  // fails, fall back to the committed state we already know instead of
  // reporting failure for a cancellation that IS persisted.
  try {
    const updated = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
    if (updated) return updated
  } catch (readErr) {
    console.error('[CancelProject] post-commit read failed:', readErr?.message || readErr)
  }
  return {
    ...project,
    status: 'cancelled',
    cancelled_at: now,
    run_token: null,
    lease_expires_at: null,
  }
}

export default cancelProjectUseCase
