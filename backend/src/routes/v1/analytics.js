import { Router } from 'express'
import { query } from '../../db/query.js'
import { authMiddleware } from '../../middleware/auth.js'

const router = Router()
router.use(authMiddleware)

// GET /api/v1/analytics
router.get('/', async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin'
    // All filters are bound params (never interpolated) and composed so that
    // every query is valid regardless of role.
    const pWhere = isAdmin ? '' : ' WHERE p.user_id = ? '
    const scopeParams = isAdmin ? [] : [req.user.id]

    const total = await query(`SELECT COUNT(*) as c FROM projects p${pWhere}`, scopeParams)
    const completed = await query(
      `SELECT COUNT(*) as c FROM projects p${pWhere ? pWhere + ' AND' : ' WHERE'} p.status = 'completed'`,
      scopeParams
    )
    const byMode = await query(`SELECT mode, COUNT(*) as c FROM projects p${pWhere} GROUP BY mode`, scopeParams)
    const credits = await query(
      `SELECT COALESCE(SUM(pl.cost_usd),0) as total FROM provider_logs pl
       JOIN projects p ON pl.project_id = p.id${isAdmin ? '' : ' WHERE p.user_id = ?'}`,
      scopeParams
    )
    const byDay = await query(
      `SELECT date(pl.created_date) as day, COUNT(*) as c, COALESCE(SUM(pl.cost_usd),0) as cost
       FROM provider_logs pl JOIN projects p ON pl.project_id = p.id
       ${isAdmin ? '' : 'WHERE p.user_id = ?'}
       GROUP BY day ORDER BY day DESC LIMIT 30`,
      scopeParams
    )
    const jobStats = await query(
      `SELECT j.status, COUNT(*) as c FROM generation_jobs j
       JOIN projects p ON j.project_id = p.id${isAdmin ? '' : ' WHERE p.user_id = ?'}
       GROUP BY j.status`,
      scopeParams
    )

    res.json({
      totalProjects: total[0]?.c || 0,
      completed: completed[0]?.c || 0,
      byMode,
      creditsUsed: Number(credits[0]?.total || 0),
      byDay,
      jobStats,
    })
  } catch (err) {
    console.error('Analytics error:', err)
    res.status(500).json({ message: 'Internal server error', code: 'INTERNAL_ERROR' })
  }
})

export default router
