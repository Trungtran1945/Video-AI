import { Router } from 'express'
import { query, queryOne, runAffected, updateById } from '../../db/query.js'
import { authMiddleware, requireRole } from '../../middleware/auth.js'
import { sendError, ERR } from '../../lib/httpError.js'
import { PROVIDER_LABELS } from '../../providers/registry.js'
import { config } from '../../config.js'
import { isRedisReady, getRedisEndpoint } from '../../queue/connection.js'
import { projectQueue } from '../../queue/projectQueue.js'
import { drainQueue } from '../../queue/drainQueue.js'
import { notifyQueue } from '../../queue/notifyQueue.js'
import { cleanupQueue } from '../../queue/cleanupQueue.js'
import { getCleanupStats } from '../../services/projectCleanup.js'

const CLEANUP_COLUMNS = 'id, project_id, operation, operation_key, status, attempts, next_attempt_at, last_error, created_date, updated_date'

const router = Router()
router.use(authMiddleware, requireRole('admin'))

// GET /api/v1/admin/users
router.get('/users', async (req, res) => {
  const users = await query('SELECT id, email, role, name, created_date FROM users ORDER BY created_date DESC')
  res.json(users)
})

// PUT /api/v1/admin/users/:id  (change role)
router.put('/users/:id', async (req, res) => {
  const { role } = req.body || {}
  if (!['user', 'admin', 'guest'].includes(role)) return sendError(res, 400, ERR.VALIDATION, 'Invalid role', { field: 'role' })
  const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id])
  if (!user) return sendError(res, 404, 'NOT_FOUND', 'User not found')
  const updated = await updateById('users', user.id, { role })
  res.json({ id: updated.id, email: updated.email, role: updated.role })
})

// GET /api/v1/admin/providers — real registry snapshot (no stub).
// Reads capability/provider matrix from the provider registry + per-env key
// presence flags. Never exposes key material (presence boolean only).
const CAPABILITY_PROVIDERS = {
  llm: ['gemini', 'openai', 'mock', 'anthropic', 'huggingface'],
  asr: ['whisper', 'openai_whisper', 'mock', 'faster_whisper'],
  tts: ['zerotts', 'edge_tts', 'elevenlabs', 'openai_tts', 'google_tts', 'mock', 'azure_speech'],
  vision: ['gemini', 'mock', 'clip'],
  translate: ['google_translate'],
}
const ENV_KEY_NAMES = {
  gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
  huggingface: 'HUGGINGFACE_TOKEN', whisper: 'WHISPER_API_KEY', openai_whisper: 'OPENAI_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY', openai_tts: 'OPENAI_API_KEY',
}

// GET /api/v1/admin/providers
router.get('/providers', async (req, res) => {
  const capabilities = Object.entries(CAPABILITY_PROVIDERS).map(([capability, ids]) => ({
    capability,
    providers: ids.map((id) => {
      const envName = ENV_KEY_NAMES[id]
      return {
        id,
        label: PROVIDER_LABELS[id] || id,
        keyless: ['zerotts', 'edge_tts', 'google_tts', 'google_translate', 'mock'].includes(id),
        envKeyConfigured: envName ? Boolean(process.env[envName]) : false,
      }
    }),
  }))
  res.json({
    global: true,
    capabilities,
    note: 'Provider keys are supplied per-user via /api-keys in this build (envKeyConfigured = server fallback presence).',
  })
})

// GET /api/v1/admin/cleanup-tasks?status=&limit=
// Lists durable cleanup outbox rows. NEVER selects keys_json (no storage-key
// material leaves the server through this endpoint).
router.get('/cleanup-tasks', async (req, res) => {
  const rawLimit = Number(req.query?.limit)
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : 20
  const status = typeof req.query?.status === 'string' ? req.query.status : null
  const rows = status === 'pending' || status === 'failed' || status === 'done'
    ? await query(`SELECT ${CLEANUP_COLUMNS} FROM project_cleanup_tasks WHERE status = ? ORDER BY created_date DESC LIMIT ?`, [status, limit])
    : await query(`SELECT ${CLEANUP_COLUMNS} FROM project_cleanup_tasks ORDER BY created_date DESC LIMIT ?`, [limit])
  res.json(rows)
})

// POST /api/v1/admin/cleanup-tasks/:id/retry
// Re-queues a failed cleanup task. Idempotent at the SQL level: the UPDATE is
// conditional on status='failed', so two concurrent retries claim at most one.
// Takes no path input — only the task id from the URL.
router.post('/cleanup-tasks/:id/retry', async (req, res) => {
  const task = await queryOne(`SELECT ${CLEANUP_COLUMNS} FROM project_cleanup_tasks WHERE id = ?`, [req.params.id])
  if (!task) return sendError(res, 404, 'NOT_FOUND', 'Cleanup task not found')
  if (task.status !== 'failed') return sendError(res, 409, 'CONFLICT', 'Only failed tasks can be retried')
  const now = new Date().toISOString()
  const affected = await runAffected(
    `UPDATE project_cleanup_tasks SET status = 'pending', next_attempt_at = ?, updated_date = ? WHERE id = ? AND status = 'failed'`,
    [now, now, req.params.id],
    { op: 'admin.cleanup.retry' }
  )
  if (affected !== 1) return sendError(res, 409, 'CONFLICT', 'Only failed tasks can be retried')
  const retried = await queryOne(`SELECT ${CLEANUP_COLUMNS} FROM project_cleanup_tasks WHERE id = ?`, [req.params.id])
  res.json(retried)
})

// GET /api/v1/admin/queue-metrics — R3 Chu kỳ 2: số liệu hàng đợi cho Admin UI.
// BullMQ depth point-in-time (không dùng cho admission — admission vẫn qua SQL
// claimQueuedProject). Redis down → degraded có số (từng queue catch riêng +
// timeout, vì BullMQ treo promise khi mất Redis thay vì reject ngay),
// KHÔNG 500. COUNT toàn bảng (admin-only) — không select keys_json.
const QUEUE_SNAPSHOT_TIMEOUT_MS = 3000
function withQueueTimeout(promise, ms = QUEUE_SNAPSHOT_TIMEOUT_MS) {
  promise.catch(() => {}) // tránh unhandled khi timeout thắng cuộc đua
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('QUEUE_TIMEOUT')), ms)
    timer.unref?.()
  })
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout])
}
async function queueSnapshot(queue) {
  try {
    const counts = await withQueueTimeout(queue.getJobCounts('waiting', 'active', 'delayed'))
    let paused = false
    try {
      paused = await withQueueTimeout(queue.isPaused())
    } catch {
      paused = false
    }
    return {
      waiting: Number(counts?.waiting || 0),
      active: Number(counts?.active || 0),
      delayed: Number(counts?.delayed || 0),
      paused,
    }
  } catch {
    return { error: 'REDIS_UNAVAILABLE' }
  }
}
router.get('/queue-metrics', async (req, res) => {
  const redisReady = isRedisReady()
  const defs = [
    ['projects', projectQueue],
    ['drain-queued', drainQueue],
    ['notifications', notifyQueue],
    ['cleanup', cleanupQueue],
  ]
  const snapshots = await Promise.all(defs.map(([, queue]) => queueSnapshot(queue)))
  const queues = Object.fromEntries(defs.map(([name], i) => [name, snapshots[i]]))
  const byProjectStatus = { pending: 0, queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }
  let oldestQueuedAt = null
  try {
    const rows = await query('SELECT status, COUNT(*) AS cnt FROM projects GROUP BY status')
    for (const row of rows || []) {
      byProjectStatus[row.status] = Number(row.cnt) || 0
    }
    const oldest = await queryOne("SELECT MIN(created_date) AS oldest FROM projects WHERE status = 'queued'")
    oldestQueuedAt = oldest?.oldest || null
  } catch {
    /* giữ zeros — degraded */
  }
  let cleanupOutbox = { pending: 0, failed: 0 }
  try {
    const stats = await getCleanupStats()
    cleanupOutbox = { pending: Number(stats?.pending || 0), failed: Number(stats?.failed || 0) }
  } catch {
    /* giữ zeros — degraded */
  }
  res.json({
    generatedAt: new Date().toISOString(),
    redis: { status: redisReady ? 'connected' : 'disconnected', endpoint: getRedisEndpoint() || null },
    bullmq: { available: redisReady },
    queues,
    dbFallback: {
      byProjectStatus,
      oldestQueuedAt,
      oldestQueuedAgeMs: oldestQueuedAt ? Math.max(0, Date.now() - new Date(oldestQueuedAt).getTime()) : 0,
      maxConcurrentPerUser: Number(config.maxConcurrentProjectsPerUser) || 2,
    },
    cleanupOutbox,
  })
})

export default router
