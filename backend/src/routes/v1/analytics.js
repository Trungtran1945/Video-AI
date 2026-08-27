import { Router } from 'express'
import { query } from '../../db/query.js'
import { authMiddleware } from '../../middleware/auth.js'
import { sendError } from '../../lib/httpError.js'

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
    const minutes = await query(
      `SELECT COALESCE(SUM(o.duration_sec),0)/60.0 as total FROM outputs o
       JOIN projects p ON o.project_id = p.id${isAdmin ? '' : ' WHERE p.user_id = ?'}`,
      scopeParams
    )
    const byDay = await query(
      `SELECT date(pl.created_date) as day, COUNT(*) as c
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
    // docs/06 §5: { videos, minutesTranslated, byProvider, byDay }
    // ADMIN đếm cả log đã detach khỏi project; USER chỉ log của dự án mình.
    const provJoin = isAdmin
      ? 'LEFT JOIN projects p ON pl.project_id = p.id'
      : 'JOIN projects p ON pl.project_id = p.id'
    const byProvider = await query(
      `SELECT pl.provider, pl.type,
              COUNT(*) as calls,
              SUM(pl.tokens_in) as tokens_in,
              SUM(pl.tokens_out) as tokens_out,
              SUM(pl.cost_usd) as cost_usd,
              SUM(CASE WHEN pl.status = 'ok' THEN 1 ELSE 0 END) as ok_calls
       FROM provider_logs pl
       ${provJoin}
       ${isAdmin ? '' : 'WHERE p.user_id = ?'}
       GROUP BY pl.provider, pl.type
       ORDER BY calls DESC`,
      scopeParams
    )

    res.json({
      videos: completed[0]?.c || 0,
      totalProjects: total[0]?.c || 0,
      completed: completed[0]?.c || 0,
      byMode,
      minutesTranslated: Math.round(Number(minutes[0]?.total || 0) * 10) / 10,
      byProvider: byProvider.map((r) => ({
        provider: r.provider,
        type: r.type,
        calls: r.calls || 0,
        successCalls: r.ok_calls || 0,
        tokensIn: Number(r.tokens_in || 0),
        tokensOut: Number(r.tokens_out || 0),
        costUsd: Math.round(Number(r.cost_usd || 0) * 10000) / 10000,
      })),
      byDay,
      jobStats,
    })
  } catch (err) {
    console.error('Analytics error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

export default router
