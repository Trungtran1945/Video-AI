import { Worker } from 'bullmq'
import fs from 'node:fs'
import path from 'path'
import { connection, createRedisConnection, createThrottledLogger, isRedisReady, isConnectionReady, waitForConnection, attachDedicatedLogging } from '../connection.js'
import { query, run } from '../../db/query.js'
import { projectDir } from '../../pipeline/context.js'
import { config } from '../../config.js'
import { isPathInside } from '../../lib/safePath.js'
import { PROJECT_RETAINABLE_STATUSES, normalizeProjectStatus } from '../../lib/projectStatus.js'
import { resumableUploadService } from '../../services/resumableUploadService.js'
import { cleanupLegacyUploads } from '../../services/legacyUploadRegistry.js'

// Throttled: a dead Redis stream emits errors continuously — log without spam.
const logWorkerError = createThrottledLogger(30000)

function retentionBackoffMs() {
  // Retention sweep runs hourly — a failed project retries on the next sweep.
  return 60 * 60 * 1000
}

// Canonical terminal states eligible for retention cleanup.
// CANCELLED is excluded by policy (cancel path cleans immediately in
// cancelProjectUseCase). 'success' is a legacy job-status leak kept in the
// WHERE clause for DBs that predate the success→completed migration; rows are
// normalized per-row and only retainable statuses are cleaned.
const RETENTION_WHERE_STATUSES = [...PROJECT_RETAINABLE_STATUSES, 'success']

/**
 * CleanupWorker — Cron repeatable job: cleanup.sweep
 * Quét projects.expires_at < cutoff AND status IN ('completed', 'failed')
 * (+ legacy 'success' compat). Xóa file trung gian trong storage/projects/{id}
 * (tmp/frames/thumbs/audios), giữ lại Output.
 * Projects CANCELLED: dọn ngay lập tức (trong cancelProjectUseCase), không quét ở đây.
 *
 * Failure semantics: filesystem cleanup bắt buộc fail → GIỮ expires_at
 * (retry ở sweep sau qua next_cleanup_attempt_at), KHÔNG tăng cleaned.
 * Chỉ success mới SET expires_at=NULL.
 */
export async function processCleanup(job) {
  const startedAt = Date.now()
  const uploadRecovery = await resumableUploadService.recoverUploadSessions()
  const uploads = await resumableUploadService.cleanupExpiredUploadSessions()
  const legacyUploads = await cleanupLegacyUploads({ root: path.join(config.storageDir, 'tmp', 'legacy_uploads'), trustedRoot: config.storageDir })
  const retentionDays = config.projectRetentionDays
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays)
  const cutoffISO = cutoffDate.toISOString()
  const nowISO = new Date().toISOString()

  let cleaned = 0
  const failed = []

  // Find expired projects with intermediate files.
  // next_cleanup_attempt_at gates poison-FS retries (backoff 1h); NULL = due.
  const placeholders = RETENTION_WHERE_STATUSES.map(() => '?').join(', ')
  let expiredProjects = []
  try {
    expiredProjects = await query(
      `SELECT id, status, user_id FROM projects
       WHERE expires_at IS NOT NULL AND expires_at < ?
       AND status IN (${placeholders})
       AND (next_cleanup_attempt_at IS NULL OR next_cleanup_attempt_at <= ?)`,
      [cutoffISO, ...RETENTION_WHERE_STATUSES, nowISO]
    )
  } catch (err) {
    // DB cũ chưa có cột next_cleanup_attempt_at → fallback không backoff gate.
    if (err?.message?.includes('no such column')) {
      expiredProjects = await query(
        `SELECT id, status, user_id FROM projects
         WHERE expires_at IS NOT NULL AND expires_at < ? AND status IN (${placeholders})`,
        [cutoffISO, ...RETENTION_WHERE_STATUSES]
      )
    } else {
      throw err
    }
  }

  for (const project of expiredProjects) {
    // Normalize legacy rows; skip non-retainable if any slipped through.
    const canonical = normalizeProjectStatus(project.status)
    if (!PROJECT_RETAINABLE_STATUSES.includes(canonical)) continue
    const dir = projectDir(project.id)
    // Trusted-root invariant: recursive deletes may only touch storage/projects/.
    const trusted = isPathInside(path.join(config.storageDir, 'projects'), dir)

    // Clean up intermediate files (keep outputs)
    let fsFailed = false
    let fsError = null
    try {
      if (trusted && fs.existsSync(dir)) {
        // Remove tmp directory contents
        const tmpDir = path.join(dir, 'tmp')
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true })
        }
        // Remove frames directory (OCR)
        const framesDir = path.join(dir, 'frames')
        if (fs.existsSync(framesDir)) {
          fs.rmSync(framesDir, { recursive: true, force: true })
        }
        // Remove thumbs directory
        const thumbsDir = path.join(dir, 'thumbs')
        if (fs.existsSync(thumbsDir)) {
          fs.rmSync(thumbsDir, { recursive: true, force: true })
        }
        // Remove intermediate audio files but keep final outputs
        const audioDir = path.join(dir, 'audios')
        if (fs.existsSync(audioDir)) {
          fs.rmSync(audioDir, { recursive: true, force: true })
        }
      }
    } catch (err) {
      fsFailed = true
      fsError = err
    }

    if (fsFailed) {
      // Failure keeps the retry signal: expires_at is RETAINED, backoff gates
      // the next attempt. cleaned is NOT incremented. No secrets logged.
      const nextRetryAt = new Date(Date.now() + retentionBackoffMs()).toISOString()
      try {
        await run(
          `UPDATE projects SET next_cleanup_attempt_at = ? WHERE id = ?`,
          [nextRetryAt, project.id]
        )
      } catch (backoffErr) {
        if (!backoffErr?.message?.includes('no such column')) throw backoffErr
        // Old DB without the column: expires_at alone still retains the signal.
      }
      failed.push(project.id)
      console.error(JSON.stringify({
        event: 'cleanup_project_failed',
        projectId: project.id,
        operation: 'cleanup.retention.sweep',
        error: fsError?.message || 'filesystem cleanup failed',
        nextRetryAt,
      }))
      continue
    }

    // Success: clear both expires_at (done marker) and backoff gate.
    try {
      await run(
        `UPDATE projects SET expires_at = NULL, next_cleanup_attempt_at = NULL WHERE id = ?`,
        [project.id]
      )
    } catch (err) {
      if (err?.message?.includes('no such column')) {
        await run(`UPDATE projects SET expires_at = NULL WHERE id = ?`, [project.id])
      } else {
        throw err
      }
    }
    cleaned++
  }

  // Also clean up storage/tmp directory for very old files
  const tmpRoot = path.join(config.storageDir, 'tmp')
  try {
    if (fs.existsSync(tmpRoot)) {
      const entries = fs.readdirSync(tmpRoot, { withFileTypes: true })
      const now = Date.now()
      const maxAge = 7 * 24 * 60 * 60 * 1000 // 7 days

      for (const entry of entries) {
        if (entry.name === 'upload_sessions' || entry.name === 'legacy_uploads') continue
        if (entry.isDirectory()) {
          const dirPath = path.join(tmpRoot, entry.name)
          if (!isPathInside(tmpRoot, dirPath)) continue
          try {
            const stat = fs.statSync(dirPath)
            if (now - stat.mtimeMs > maxAge) {
              fs.rmSync(dirPath, { recursive: true, force: true })
              cleaned++
            }
          } catch (_) {}
        }
      }
    }
  } catch (err) {
    console.error('[Cleanup] Error cleaning tmp directory:', err.message)
  }

  return {
    cleaned,
    failed,
    failedCount: failed.length,
    uploads,
    uploadRecovery,
    legacyUploads,
    durationMs: Date.now() - startedAt,
  }
}

/**
 * Safe Worker factory — dedicated connection created → error listener
 * attached immediately → wait for dedicated READY → create Worker.
 */
export async function startCleanupWorker(opts = {}) {
  const workerConnection = opts.connection || createRedisConnection()
  attachDedicatedLogging(workerConnection, 'Cleanup')
  const waitMs = opts.waitTimeoutMs ?? 5000
  const dedicatedReady = await waitForConnection(workerConnection, waitMs)
  if (!dedicatedReady) {
    console.warn('[Cleanup] Dedicated Redis connection not ready — worker starts paused')
  }

  const worker = new Worker('cleanup', processCleanup, {
    connection: workerConnection,
    concurrency: 1,
    limiter: { max: 1, duration: 300000 }, // Max 1 job per 5 minutes
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
    logWorkerError(`[Cleanup] Worker error: ${err.message}`)
  })

  worker.on('failed', (job, err) => {
    console.error('[Cleanup] Job failed:', err.message)
  })

  worker.on('completed', (job, result) => {
    console.log(JSON.stringify({ event: 'cleanup_completed', ...result }))
  })

  return worker
}

export default startCleanupWorker
