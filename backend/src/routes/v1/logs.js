import { Router } from 'express'
import { query } from '../../db/query.js'
import { authMiddleware } from '../../middleware/auth.js'

const router = Router()
router.use(authMiddleware)

// GET /api/v1/logs
router.get('/', async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin'
    let sql = `SELECT pl.*, p.title as project_title FROM provider_logs pl
               LEFT JOIN projects p ON pl.project_id = p.id`
    const params = []
    if (!isAdmin) { sql += ' WHERE p.user_id = ? OR pl.project_id IS NULL'; params.push(req.user.id) }
    sql += ' ORDER BY pl.created_date DESC LIMIT ?'
    params.push(Number(req.query.limit) || 100)
    const rows = await query(sql, params)
    // Normalize to the frontend vocabulary (docs/02 §6 deviation):
    // DB stores 'ok'/'error'; API speaks 'success'/'error'. Also expose
    // cost_estimate as the alias Dashboard uses for credits.
    res.json(rows.map((r) => ({
      ...r,
      status: r.status === 'ok' ? 'success' : r.status,
      cost_estimate: r.cost_usd ?? 0,
    })))
  } catch (err) {
    console.error('Logs error:', err)
    res.status(500).json({ message: 'Internal server error', code: 'INTERNAL_ERROR' })
  }
})

export default router
