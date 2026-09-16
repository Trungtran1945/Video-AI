import { Worker } from 'bullmq'
import { connection, createThrottledLogger, isRedisReady } from '../connection.js'
import { query, queryOne, run } from '../../db/query.js'
import { runPipeline } from '../../pipeline/runner.js'
import { config } from '../../config.js'

const STALE_RUNNING_MINUTES = 30

// Throttled: a dead Redis stream emits errors continuously — log without spam.
const logWorkerError = createThrottledLogger(30000)

/**
 * DrainQueuedWorker — Quét projects có status='QUEUED', enqueue project
 * cũ nhất khi user đó có slot RUNNING trống.
 * Đồng thời dọn các project stuck 'running' quá lâu (backend crash mid-pipeline).
 */
const worker = new Worker('drain-queued', async (job) => {
  const maxConcurrent = config.maxConcurrentProjectsPerUser

  // ── 1. Recover stuck projects (running too long → failed) ──
  const staleCutoff = new Date(Date.now() - STALE_RUNNING_MINUTES * 60 * 1000).toISOString()
  // NOTE: projects has no per-update timestamp column (see schema.js), so
  // created_date is used as the stale-cutoff proxy. Do not add another column.
  const staleProjects = await query(
    `SELECT id, title, user_id FROM projects WHERE status = 'running' AND created_date < ?`,
    [staleCutoff]
  )

  let recovered = 0
  for (const p of staleProjects) {
    await run(
      `UPDATE projects SET status = 'failed' WHERE id = ?`,
      [p.id]
    )
    // Mark any running/pending jobs for this project as failed
    await run(
      `UPDATE generation_jobs SET status = 'failed', step = 'error', error_message = 'Pipeline interrupted — backend restarted or timed out'
       WHERE project_id = ? AND status IN ('running', 'pending')`,
      [p.id]
    )
    console.warn(`[DrainQueued] Recovered stuck project "${p.title}" (${p.id}) — marked failed`)
    recovered++
  }

  // ── 2. Drain queued projects ──
  const usersWithQueued = await queryOne(
    `SELECT DISTINCT user_id FROM projects WHERE status = 'queued'`
  )

  if (!usersWithQueued) return { drained: 0, recovered }

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

  return { drained, recovered }
}, {
  connection,
  concurrency: 1,
  limiter: { max: 10, duration: 60000 }, // Max 10 jobs per minute
})

// Pause (never close) while Redis is down so no job is lost; resume on ready.
connection.on('close', () => { worker.pause().catch(() => {}) })
connection.on('end', () => { worker.pause().catch(() => {}) })
connection.on('ready', () => { worker.resume().catch(() => {}) })
if (!isRedisReady()) worker.pause().catch(() => {})

worker.on('error', (err) => {
  logWorkerError(`[DrainQueued] Worker error: ${err.message}`)
})

worker.on('failed', (job, err) => {
  console.error('[DrainQueued] Job failed:', err.message)
})

worker.on('completed', (job, result) => {
  if (result.recovered > 0) {
    console.log(`[DrainQueued] Recovered ${result.recovered} stuck project(s)`)
  }
  if (result.drained > 0) {
    console.log(`[DrainQueued] Drained ${result.drained} queued project(s)`)
  }
})

export default worker
