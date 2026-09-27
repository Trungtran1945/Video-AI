import { Router } from 'express'
import { query, queryOne, runAffected, updateById } from '../../db/query.js'
import { authMiddleware, requireRole } from '../../middleware/auth.js'
import { sendError, ERR } from '../../lib/httpError.js'

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

// GET /api/v1/admin/providers
router.get('/providers', async (req, res) => {
  res.json({
    global: true,
    note: 'Provider keys are supplied per-user via /api-keys in this build.',
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

export default router
