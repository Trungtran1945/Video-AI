import { Router } from 'express'
import { query } from '../../db/query.js'
import { authMiddleware } from '../../middleware/auth.js'

const router = Router()
router.use(authMiddleware)

// GET /api/v1/queue — all recent jobs (active + completed) with the
// provider/cost/duration fields the Queue page renders.
router.get('/', async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin'
    let sql = `SELECT j.*, p.user_id, p.title as project_title, p.mode,
                      pl.provider AS provider,
                      pl.duration_ms AS duration_ms,
                      COALESCE(pl.cost_usd, 0) AS cost_estimate
               FROM generation_jobs j
               JOIN projects p ON j.project_id = p.id
               LEFT JOIN provider_logs pl ON pl.job_id = j.id AND pl.status = 'ok'`
    const params = []
    if (!isAdmin) { sql += ' WHERE p.user_id = ?'; params.push(req.user.id) }
    sql += ' ORDER BY j.created_date DESC LIMIT 200'
    const rows = await query(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('Queue error:', err)
    res.status(500).json({ message: 'Internal server error', code: 'INTERNAL_ERROR' })
  }
})

export default router
