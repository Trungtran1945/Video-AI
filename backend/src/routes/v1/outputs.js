import { Router } from 'express'
import { query, queryOne, insert, updateById } from '../../db/query.js'
import { authMiddleware, requireRole } from '../../middleware/auth.js'
import { requireOutputOwner } from '../../middleware/projectAccess.js'
import { sendError, ERR } from '../../lib/httpError.js'

const router = Router()
router.use(authMiddleware)

// GET /api/v1/outputs?projectId=
router.get('/', async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin'
    let sql = `SELECT o.*, p.user_id, p.title as project_title, p.mode
               FROM outputs o JOIN projects p ON o.project_id = p.id`
    const params = []
    if (!isAdmin) { sql += ' WHERE p.user_id = ?'; params.push(req.user.id) }
    if (req.query.projectId) { sql += (params.length ? ' AND' : ' WHERE') + ' o.project_id = ?'; params.push(req.query.projectId) }
    sql += ' ORDER BY o.created_date DESC'
    const rows = await query(sql, params)
    res.json(rows.map((r) => ({ ...r, url: r.storage_key ? `/storage/${r.storage_key}` : null })))
  } catch (err) {
    console.error('List outputs error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// GET /api/v1/outputs/:id
router.get('/:id', async (req, res) => {
  const o = await queryOne(`SELECT o.*, p.user_id FROM outputs o JOIN projects p ON o.project_id = p.id WHERE o.id = ?`, [req.params.id])
  if (!o) return sendError(res, 404, 'NOT_FOUND', 'Output not found')
  if (o.user_id !== req.user.id && req.user.role !== 'admin') return sendError(res, 403, ERR.AUTH_FORBIDDEN, 'Forbidden')
  res.json({ ...o, url: o.storage_key ? `/storage/${o.storage_key}` : null })
})

const YOUTUBE_PRIVACY = ['private', 'unlisted', 'public']

// POST /api/v1/outputs/:id/youtube (docs/06 §4)
// Stub: hàng đợi youtube_uploads status='pending' — upload thật (Google OAuth) chưa gắn.
// Idempotent: không tạo row mới nếu đã có job pending/uploading cho output này.
router.post('/:id/youtube', requireOutputOwner, async (req, res) => {
  const privacy = req.body?.privacy || 'private'
  if (!YOUTUBE_PRIVACY.includes(privacy)) {
    return sendError(res, 400, ERR.VALIDATION, `privacy must be one of ${YOUTUBE_PRIVACY.join(', ')}`, { field: 'privacy' })
  }
  const existing = await queryOne(
    `SELECT * FROM youtube_uploads WHERE output_id = ? AND status IN ('pending','uploading','processing') ORDER BY rowid DESC LIMIT 1`,
    [req.output.id]
  )
  if (existing) {
    return res.json({ message: 'YouTube upload already queued', upload: existing, queued: false })
  }
  const upload = await insert('youtube_uploads', {
    id: crypto.randomUUID(),
    output_id: req.output.id,
    status: 'pending',
    privacy,
    error_message: null,
  })
  // Real upload would be triggered here; stubbed as pending.
  res.json({ message: 'YouTube upload queued (stub)', upload, queued: true })
})

// GET /api/v1/outputs/:id/youtube
router.get('/:id/youtube', requireOutputOwner, async (req, res) => {
  const row = await queryOne('SELECT * FROM youtube_uploads WHERE output_id = ? ORDER BY rowid DESC LIMIT 1', [req.output.id])
  res.json(row || { status: 'none' })
})

export default router
