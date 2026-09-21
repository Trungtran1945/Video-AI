import './src/config.js'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'node:fs'
import { getDb } from './src/db.js'
import { initSchema } from './src/db/schema.js'
import { seed } from './src/db/seed.js'
import { config } from './src/config.js'
import { ffmpegAvailable } from './src/media/ffmpeg.js'
import { query, run } from './src/db/query.js'
import v1Router from './src/routes/v1/index.js'

// Group 1: Queue workers (lazy import to avoid crash if Redis unavailable)
let drainQueuedWorker = null
let notifyWorker = null
let cleanupWorker = null

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = config.port

app.use(cors())
app.use(express.json({ limit: '2gb' }))
app.use(express.urlencoded({ extended: true }))

// Serve uploaded / generated files
app.use('/storage', express.static(path.join(config.storageDir)))

app.use('/api/v1', v1Router)

app.get('/health', async (req, res) => {
  let redisOk = false
  try {
    const { isRedisReady } = await import('./src/queue/connection.js')
    redisOk = isRedisReady()
  } catch (_) {}
  res.json({
    status: 'ok',
    redis: redisOk ? 'connected' : 'disconnected',
    queueSystem: redisOk ? 'available' : 'unavailable — notifications and cleanup disabled',
  })
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

  // ── Recover projects stuck in 'running' from previous crash/restart ──
  // Park as queued (not failed) with artifacts preserved, so drain/manual
  // retry resumes from the earliest incomplete stage via firstRunnableStage.
  // Never stuck in 'running'; never delete valid artifacts here.
  try {
    const stale = await query(`SELECT id, title FROM projects WHERE status = 'running'`)
    if (stale.length > 0) {
      for (const p of stale) {
        await run(`UPDATE projects SET status = 'queued' WHERE id = ?`, [p.id])
        await run(
          `UPDATE generation_jobs SET status = 'pending', step = 'queued', error_message = 'Pipeline interrupted — server restarted, queued for resume'
           WHERE project_id = ? AND status IN ('running', 'pending')`,
          [p.id]
        )
        console.warn(`[Server] Reset stuck project "${p.title}" (${p.id}) to queued for resume`)
      }
      console.log(`[Server] Recovered ${stale.length} stale project(s) from previous session`)
    }
  } catch (e) {
    console.warn('[Server] Stale project recovery failed:', e.message)
  }

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
