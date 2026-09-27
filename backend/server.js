import './src/config.js'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'node:fs'
import { getDb, getDbPersistenceStats, getDbPersistenceHealth, PERSISTENCE_STATES } from './src/db.js'
import { getWriteQueueStats } from './src/db/query.js'
import { getRefreshFallbackStats } from './src/lib/refreshMetrics.js'
import { getCleanupStats } from './src/services/projectCleanup.js'
import { initSchema } from './src/db/schema.js'
import { seed } from './src/db/seed.js'
import { config, isOriginAllowed } from './src/config.js'
import { ffmpegAvailable } from './src/media/ffmpeg.js'
import { createSafeMediaStatic } from './src/middleware/safeMediaStatic.js'
import { resumableUploadService } from './src/services/resumableUploadService.js'
import { sweepProjectCleanupTasks } from './src/services/projectCleanup.js'

import v1Router from './src/routes/v1/index.js'

// Group 1: Queue workers (lazy import to avoid crash if Redis unavailable)
let drainQueuedWorker = null
let notifyWorker = null
let cleanupWorker = null

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = config.port

app.use(cors({
  origin: (origin, callback) => {
    // Same-origin / curl / non-browser (no Origin header) always allowed.
    if (!origin) return callback(null, true)
    if (isOriginAllowed(origin)) return callback(null, true)
    callback(new Error(`CORS: origin not allowed: ${origin}`))
  },
  credentials: true,
}))
// Tight global JSON limit (1MB): API payloads are KB-scale (project create,
// mask CRUD, translation patch). Large video uploads bypass this via
// multer (multipart) and express.raw 16MB chunk endpoints in upload.js.
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true, limit: '1mb' }))

// Serve uploaded / generated files
app.use('/storage', createSafeMediaStatic({ storageDir: config.storageDir }))

app.use('/api/v1', v1Router)

app.get('/health', async (req, res) => {
  let redisOk = false
  try {
    const { isRedisReady } = await import('./src/queue/connection.js')
    redisOk = isRedisReady()
  } catch (_) {}
  const persistence = getDbPersistenceStats()
  const health = getDbPersistenceHealth()
  const writes = getWriteQueueStats()
  // Liveness: process is alive. Persistence state is reported explicitly so
  // operators can distinguish HEALTHY / DEGRADED / WRITE_BLOCKED.
  // Redis down never fails liveness (always 200 here; /ready gates writes).
  const status = health.state === PERSISTENCE_STATES.HEALTHY
    ? 'ok'
    : health.state === PERSISTENCE_STATES.DEGRADED
      ? 'degraded'
      : 'unavailable'
  let cleanupStats = { pending: 0, failed: 0, oldestPendingAgeMs: 0, lastFailureAt: null }
  try {
    cleanupStats = await getCleanupStats()
  } catch (_) {}
  let refreshFallbackStats = { count: 0, lastAt: null, deprecated: true, removalTarget: 'v2' }
  try {
    refreshFallbackStats = getRefreshFallbackStats()
  } catch (_) {}
  res.json({
    status,
    redis: redisOk ? 'connected' : 'disconnected',
    bullmq: redisOk ? 'available' : 'unavailable',
    durableCleanup: 'available',
    cleanup: cleanupStats,
    database: {
      ...persistence,
      persistenceState: health.state,
      consecutiveSaveFailures: health.consecutiveSaveFailures,
      lastSuccessfulSaveAt: health.lastSuccessfulSaveAt,
      lastSaveError: health.lastSaveError,
      maxSaveFailures: health.maxSaveFailures,
    },
    writes,
    auth: { refreshFallback: refreshFallbackStats },
  })
})

// Readiness: WRITE_BLOCKED → 503 + ready:false (orchestrator stops routing
// writes here). DEGRADED stays 200 + ready:true so transient save hiccups
// don't cause restart loops. Redis is reported but never gates readiness
// (dev runs without Redis; prod fail-fasts at boot instead).
app.get('/ready', async (req, res) => {
  let redisOk = false
  try {
    const { isRedisReady } = await import('./src/queue/connection.js')
    redisOk = isRedisReady()
  } catch (_) {}
  const health = getDbPersistenceHealth()
  const ready = health.state !== PERSISTENCE_STATES.WRITE_BLOCKED
  const body = {
    ready,
    database: {
      persistenceState: health.state,
      consecutiveSaveFailures: health.consecutiveSaveFailures,
      lastSuccessfulSaveAt: health.lastSuccessfulSaveAt,
      lastSaveError: health.lastSaveError,
    },
    redis: redisOk ? 'connected' : 'disconnected',
  }
  res.status(ready ? 200 : 503).json(body)
})

async function tryListen(port, attempt = 0) {
  const maxAttempts = 10
  const p = Number(port)
  return new Promise((resolve, reject) => {
    const server = app.listen(p, () => {
      console.log(`[Server] Backend running at http://localhost:${p}`)
      resolve(server)
    })
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
        const nextPort = p + 1
        console.log(`[Server] Port ${p} in use, trying ${nextPort}...`)
        server.close(() => tryListen(nextPort, attempt + 1).then(resolve, reject))
      } else if (err.code === 'EADDRINUSE') {
        console.error(`[Server] Could not find an available port after ${maxAttempts} attempts`)
        reject(err)
      } else {
        reject(err)
      }
    })
  })
}

async function start() {
  const ff = await ffmpegAvailable()
  if (ff.ok) console.log(`[Media] ${ff.version}`)
  else console.warn(`[Media] FFmpeg chưa sẵn sàng — pipeline render sẽ thất bại. Cài FFmpeg hoặc đặt FFMPEG_PATH trong backend/.env`)
  await getDb()
  console.log('[DB] SQLite initialized')
  await initSchema()
  await seed()
  const uploadRecovery = await resumableUploadService.recoverUploadSessions()
  console.log(`[Upload] Startup recovery completed: ${JSON.stringify(uploadRecovery)}`)

  // ── Recover projects stuck in 'running' from previous crash/restart ──
  // Single shared service (see src/pipeline/recovery.js): heartbeat-based,
  // idempotent, preserves artifacts, never touches live in-process runs.
  // At boot there are no live runs in this process, so every stale 'running'
  // project is parked as queued for resume via firstRunnableStage.
  try {
    const { recoverStaleProjects, RECOVERY_REASON_RESTART } = await import('./src/pipeline/recovery.js')
    const r = await recoverStaleProjects({ timeoutMin: 0, reason: RECOVERY_REASON_RESTART })
    if (r.recovered > 0) {
      console.log(`[Server] Recovered ${r.recovered} stale project(s) from previous session`)
    }
  } catch (e) {
    console.warn('[Server] Stale project recovery failed:', e.message)
  }

  // Durable cleanup retry (không phụ thuộc Redis): quét task đến hạn mỗi 60s
  // + một lần ngay khi boot (task sót từ lần chạy trước/crash giữa chừng).
  // INSTANCE_MODE=single nên một interval in-process là đủ ngay cả khi Redis
  // down; BullMQ hourly sweep (cleanupWorker + safeAddCleanup) giữ nguyên.
  sweepProjectCleanupTasks().catch((e) => console.error('[Cleanup] boot sweep lỗi:', e?.message || e))
  try {
    const { pruneExpiredIdempotency } = await import('./src/services/projectAdmission.js')
    pruneExpiredIdempotency().catch((e) => console.error('[Idempotency] boot prune lỗi:', e?.message || e))
  } catch (e) {
    console.warn('[Idempotency] boot prune skipped:', e?.message || e)
  }
  const cleanupSweepTimer = setInterval(() => {
    sweepProjectCleanupTasks().catch((e) => console.error('[Cleanup] sweep lỗi:', e?.message || e))
  }, 60_000)
  // Idempotency TTL prune hourly (not every minute: a no-op DELETE would still
  // rewrite data.db through the atomic persist path).
  const idemPruneTimer = setInterval(() => {
    import('./src/services/projectAdmission.js')
      .then((m) => m.pruneExpiredIdempotency())
      .catch((e) => console.error('[Idempotency] prune lỗi:', e?.message || e))
  }, 60 * 60 * 1000)
  if (typeof cleanupSweepTimer.unref === 'function') cleanupSweepTimer.unref()
  if (typeof idemPruneTimer.unref === 'function') idemPruneTimer.unref()

  // Group 1: Start queue workers (graceful fallback if Redis unavailable).
  // Workers are only constructed once the Redis stream is writable — this
  // avoids "Stream isn't writeable" command spam. If Redis is down at boot,
  // boot is deferred until the connection is ready.
  let queueBooted = false
  async function bootQueueWorkers() {
    if (queueBooted) return
    queueBooted = true
    try {
      const drainMod = await import('./src/queue/workers/drainQueued.js')
      const startDrain = drainMod.startDrainQueuedWorker || drainMod.default
      drainQueuedWorker = await startDrain()
      const { safeAddDrainSweep } = await import('./src/queue/drainQueue.js')
      await safeAddDrainSweep()
      console.log('[Queue] DrainQueued worker started')
    } catch (e) {
      console.warn('[Queue] DrainQueued worker failed to start:', e.message)
    }

    try {
      const notifyMod = await import('./src/queue/workers/notifyWorker.js')
      const startNotify = notifyMod.startNotifyWorker || notifyMod.default
      notifyWorker = await startNotify()
      console.log('[Queue] Notify worker started')
    } catch (e) {
      console.warn('[Queue] Notify worker failed to start:', e.message)
    }

    try {
      const cleanupMod = await import('./src/queue/workers/cleanupWorker.js')
      const startCleanup = cleanupMod.startCleanupWorker || cleanupMod.default
      cleanupWorker = await startCleanup()
      // Schedule cleanup to run every hour (isolated — never throw from boot).
      const { safeAddCleanup } = await import('./src/queue/cleanupQueue.js')
      await safeAddCleanup('sweep', {}, {
        repeat: { every: 60 * 60 * 1000 }, // every hour
        removeOnComplete: true,
      })
      console.log('[Queue] Cleanup worker started (every hour)')
    } catch (e) {
      console.warn('[Queue] Cleanup worker/cron failed to start:', e.message)
    }
  }

  try {
    const { connection, waitForRedis, getRedisEndpoint } = await import('./src/queue/connection.js')
    if (await waitForRedis(3000)) {
      await bootQueueWorkers()
    } else if (config.nodeEnv === 'production') {
      // Redis bắt buộc ở production: fail fast với diagnostic rõ ràng thay vì
      // chạy mù rồi spam "Stream isn't writeable" ở mọi worker.
      console.error(`[Queue] FATAL: Redis unavailable at ${getRedisEndpoint()} — workers (notifications, cleanup, job draining) require Redis. Start it (docker compose up redis) or set REDIS_HOST/REDIS_PORT in backend/.env`)
      process.exit(1)
    } else {
      console.warn('[Queue] Redis unavailable — notifications, cleanup, and job draining are disabled (workers will start when Redis is ready)')
      connection.once('ready', () => {
        bootQueueWorkers().catch((e) => console.warn('[Queue] deferred worker boot failed:', e.message))
      })
    }
  } catch (e) {
    console.warn('[Queue] Redis module failed to load — queue features disabled:', e.message)
  }

  // Log final queue system status
  try {
    const { isRedisReady } = await import('./src/queue/connection.js')
    if (isRedisReady()) {
      console.log('[Queue] Redis connected — all queue features available')
    } else {
      console.warn('[Queue] Redis unavailable — notifications, cleanup, and job draining are disabled')
    }
  } catch (_) {
    console.warn('[Queue] Redis module failed to load — queue features disabled')
  }

  await tryListen(PORT)
}

start().catch((e) => {
  console.error('[Server] Failed to start:', e)
  process.exit(1)
})
