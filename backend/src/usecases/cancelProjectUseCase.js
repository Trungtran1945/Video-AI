import { queryOne, run } from '../db/query.js'
import { projectDir } from '../pipeline/context.js'
import fs from 'node:fs'
import path from 'path'
import { abortPipeline } from '../pipeline/runner.js'
import { notifyQueue } from '../queue/notifyQueue.js'

/**
 * CancelProjectUseCase — FR-J1
 * Cancel all PENDING/RUNNING jobs for a project, set status to 'cancelled',
 * clean up temp files. Idempotent: calling on finished project returns current status.
 */
export async function cancelProjectUseCase(projectId) {
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
  if (!project) throw new Error('Project not found')

  // Idempotent: already finished
  if (['completed', 'failed', 'cancelled'].includes(project.status)) {
    return project
  }

  const now = new Date().toISOString()

  // Set project status to cancelled
  await run(
    `UPDATE projects SET status = 'cancelled', cancelled_at = ? WHERE id = ?`,
    [now, projectId]
  )

  // Mark all pending/running jobs as cancelled
  await run(
    `UPDATE generation_jobs SET status = 'cancelled', cancelled_at = ?, step = 'cancelled'
     WHERE project_id = ? AND status IN ('pending', 'running')`,
    [now, projectId]
  )

  // Abort any running pipeline stages
  abortPipeline(projectId)

  // Clean up temp files in storage/tmp/{projectId}
  const tmpDir = path.join(projectDir(projectId))
  try {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  } catch (_) {}

  // Send notification on cancel
  try {
    const user = await queryOne('SELECT email FROM users WHERE id = ?', [project.user_id])
    if (user?.email) {
      await notifyQueue.add('projectDone', {
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

  // Return updated project
  return queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
}

export default cancelProjectUseCase
