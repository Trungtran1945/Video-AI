import { Worker } from 'bullmq'
import { connection } from '../connection.js'
import { queryOne, run } from '../../db/query.js'
import { runPipeline } from '../../pipeline/runner.js'
import { config } from '../../config.js'

/**
 * DrainQueuedWorker — Quét projects có status='QUEUED', enqueue project
 * cũ nhất khi user đó có slot RUNNING trống.
 */
const worker = new Worker('drain-queued', async (job) => {
  const maxConcurrent = config.maxConcurrentProjectsPerUser

  // Find users with queued projects
  const usersWithQueued = await queryOne(
    `SELECT DISTINCT user_id FROM projects WHERE status = 'queued'`
  )

  if (!usersWithQueued) return { drained: 0 }

  let drained = 0

  // Get all unique user_ids with queued projects
  const rows = await queryOne(
    `SELECT user_id, COUNT(*) as cnt FROM projects WHERE status = 'queued' GROUP BY user_id`
  )

  // For each user, check if they have a slot available
  const userIds = rows ? [rows] : []

  for (const userRow of userIds) {
    const userId = userRow.user_id

    // Count running projects for this user
    const running = await queryOne(
      `SELECT COUNT(*) as cnt FROM projects WHERE user_id = ? AND status = 'running'`,
      [userId]
    )
    const runningCount = running?.cnt || 0

    if (runningCount < maxConcurrent) {
      // Get oldest queued project for this user
      const oldest = await queryOne(
        `SELECT id FROM projects WHERE user_id = ? AND status = 'queued' ORDER BY created_date ASC LIMIT 1`,
        [userId]
      )

      if (oldest) {
        // Update status to pending and enqueue
        await run(
          `UPDATE projects SET status = 'pending' WHERE id = ?`,
          [oldest.id]
        )
        runPipeline(oldest.id).catch((e) => console.error('[DrainQueued] start failed', e))
        drained++
      }
    }
  }

  return { drained }
}, {
  connection,
  concurrency: 1,
  limiter: { max: 10, duration: 60000 }, // Max 10 jobs per minute
})

worker.on('failed', (job, err) => {
  console.error('[DrainQueued] Job failed:', err.message)
})

worker.on('completed', (job, result) => {
  if (result.drained > 0) {
    console.log(`[DrainQueued] Drained ${result.drained} queued project(s)`)
  }
})

export default worker
