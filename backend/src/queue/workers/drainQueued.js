import { Worker } from 'bullmq'
import { connection, createRedisConnection, createThrottledLogger, isRedisReady, isConnectionReady, waitForConnection, attachDedicatedLogging } from '../connection.js'
import { query, queryOne, run } from '../../db/query.js'
import { runPipeline, isPipelineRunning } from '../../pipeline/runner.js'
import { config } from '../../config.js'

const STALE_RUNNING_MINUTES = 30

// Throttled: a dead Redis stream emits errors continuously — log without spam.
const logWorkerError = createThrottledLogger(30000)

/**
 * DrainQueuedWorker — Quét projects có status='QUEUED', enqueue project
 * cũ nhất khi user đó có slot RUNNING trống.
 * Đồng thời dọn các project stuck 'running' quá lâu (backend crash mid-pipeline).
 */
async function processDrainQueued(job) {
  const maxConcurrent = config.maxConcurrentProjectsPerUser

  // ── 1. Recover stuck projects (running too long → queued for resume) ──
  // Resume (not terminal fail): artifacts are preserved so the next retry /
  // regenerate resumes from the earliest incomplete stage via firstRunnableStage.
  // Skip projects with a live in-process run — killing them would corrupt output.
  const staleCutoff = new Date(Date.now() - STALE_RUNNING_MINUTES * 60 * 1000).toISOString()
  // NOTE: projects has no per-update timestamp column (see schema.js), so
  // created_date is used as the stale-cutoff proxy. Do not add another column.
  const staleProjects = await query(
    `SELECT id, title, user_id FROM projects WHERE status = 'running' AND created_date < ?`,
    [staleCutoff]
  )

  let recovered = 0
  for (const p of staleProjects) {
    try {
      if (isPipelineRunning(p.id)) continue
    } catch (_) {}
    await run(
      `UPDATE projects SET status = 'queued' WHERE id = ?`,
      [p.id]
    )
    // Park running/pending jobs for resume (do not mark failed — resume path
    // follows stage order, failed would need manual retry).
    await run(
      `UPDATE generation_jobs SET status = 'pending', step = 'queued', error_message = 'Pipeline interrupted — queued for resume'
       WHERE project_id = ? AND status IN ('running', 'pending')`,
      [p.id]
    )
    console.warn(`[DrainQueued] Recovered stuck project "${p.title}" (${p.id}) — queued for resume`)
    recovered++
  }

  // ── 2. Drain queued projects ──
  const usersWithQueued = await queryOne(
    `SELECT DISTINCT user_id FROM projects WHERE status = 'queued'`
  )

  if (!usersWithQueued) return { drained: 0, recovered }

  let drained = 0

  // Get all unique user_ids with queued projects
  const rows = await query(
    `SELECT user_id, COUNT(*) as cnt FROM projects WHERE status = 'queued' GROUP BY user_id`
  )

  // For each user, check if they have a slot available
  const userIds = rows || []

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
}

/**
 * Safe Worker factory — BullMQ/ioredis lifecycle:
 *   dedicated connection created → error listener attached immediately →
 *   wait for dedicated READY → create Worker → attach worker error listener
 *   immediately → wire pause/resume on BOTH main + dedicated streams →
 *   start paused when either stream is not ready.
 * Never issues Redis commands before the dedicated stream is writable, so
 * `Stream isn't writeable and enableOfflineQueue options is false` cannot
 * fire during startup/reconnect. Never closes the worker on disconnect
 * (pause only — no job loss).
 */
export async function startDrainQueuedWorker(opts = {}) {
  const workerConnection = opts.connection || createRedisConnection()
  attachDedicatedLogging(workerConnection, 'DrainQueued')
  const waitMs = opts.waitTimeoutMs ?? 5000
  const dedicatedReady = await waitForConnection(workerConnection, waitMs)
  if (!dedicatedReady) {
    console.warn('[DrainQueued] Dedicated Redis connection not ready — worker starts paused')
  }

  const worker = new Worker('drain-queued', processDrainQueued, {
    connection: workerConnection,
    concurrency: 1,
    limiter: { max: 10, duration: 60000 }, // Max 10 jobs per minute
  })

  // Pause (never close) while Redis is down so no job is lost; resume on ready.
  connection.on('close', () => { worker.pause().catch(() => {}) })
  connection.on('end', () => { worker.pause().catch(() => {}) })
  connection.on('ready', () => { worker.resume() })
  workerConnection.on('close', () => { worker.pause().catch(() => {}) })
  workerConnection.on('end', () => { worker.pause().catch(() => {}) })
  workerConnection.on('ready', () => { worker.resume() })
  if (!isRedisReady()) worker.pause().catch(() => {})
  if (!isConnectionReady(workerConnection)) worker.pause().catch(() => {})

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

  return worker
}

export default startDrainQueuedWorker
