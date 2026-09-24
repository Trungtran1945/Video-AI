import { Worker } from 'bullmq'
import { connection, createRedisConnection, createThrottledLogger, isRedisReady, isConnectionReady, waitForConnection, attachDedicatedLogging } from '../connection.js'
import { query, queryOne } from '../../db/query.js'
import { runPipeline } from '../../pipeline/runner.js'
import { recoverStaleProjects, RECOVERY_REASON_STALE } from '../../pipeline/recovery.js'
import { claimQueuedProject } from '../claim.js'
import { config } from '../../config.js'

// Throttled: a dead Redis stream emits errors continuously — log without spam.
const logWorkerError = createThrottledLogger(30000)

/**
 * DrainQueuedWorker — Quét projects có status='QUEUED', enqueue project
 * cũ nhất khi user đó có slot RUNNING trống.
 * Đồng thời dọn các project stuck 'running' quá lâu (backend crash mid-pipeline).
 */
async function processDrainQueued(job) {
  const maxConcurrent = config.maxConcurrentProjectsPerUser

  // ── 1. Recover stale projects via the shared service ──
  // Heartbeat-based (last_heartbeat_at/started_at), never created_date.
  // Artifacts preserved; live in-process runs skipped; idempotent.
  const recovery = await recoverStaleProjects({
    timeoutMin: config.recoveryStaleMinutes,
    reason: RECOVERY_REASON_STALE,
  })
  const recovered = recovery.recovered
  if (recovered > 0) {
    console.warn(`[DrainQueued] Recovered ${recovered} stale project(s) — queued for resume`)
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
      `SELECT COUNT(*) as cnt FROM projects WHERE user_id = ? AND status IN ('pending', 'running')`,
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
        // Atomic single-winner claim (conditional UPDATE on status='queued').
        // Losers get claimed:false and must NOT call runPipeline().
        const claim = await claimQueuedProject(oldest.id)
        if (!claim.claimed) continue
        runPipeline(oldest.id, null, claim.runToken).catch((e) => console.error('[DrainQueued] start failed', e))
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
