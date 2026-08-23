import { Router } from 'express'
import { query, queryOne, insert, updateById } from '../../db/query.js'
import { authMiddleware, requireRole } from '../../middleware/auth.js'
import { requireOutputOwner } from '../../middleware/projectAccess.js'

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
    res.status(500).json({ message: 'Internal server error', code: 'INTERNAL_ERROR' })
  }
})

// GET /api/v1/outputs/:id
router.get('/:id', async (req, res) => {
  const o = await queryOne(`SELECT o.*, p.user_id FROM outputs o JOIN projects p ON o.project_id = p.id WHERE o.id = ?`, [req.params.id])
  if (!o) return res.status(404).json({ message: 'Output not found', code: 'NOT_FOUND' })
  if (o.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden', code: 'FORBIDDEN' })
  res.json({ ...o, url: o.storage_key ? `/storage/${o.storage_key}` : null })
})

// POST /api/v1/outputs/:id/youtube
router.post('/:id/youtube', requireOutputOwner, async (req, res) => {
  const upload = await insert('youtube_uploads', {
    id: crypto.randomUUID(),
    output_id: req.output.id,
    status: 'pending',
    privacy: req.body?.privacy || 'private',
    error_message: null,
  })
  // Real upload would be triggered here; stubbed as pending.
  res.json({ message: 'YouTube upload queued (stub)', upload })
})

// GET /api/v1/outputs/:id/youtube
router.get('/:id/youtube', requireOutputOwner, async (req, res) => {
  const row = await queryOne('SELECT * FROM youtube_uploads WHERE output_id = ? ORDER BY rowid DESC LIMIT 1', [req.output.id])
  res.json(row || { status: 'none' })
})

export default router
