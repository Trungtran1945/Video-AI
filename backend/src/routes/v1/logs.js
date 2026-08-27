import { Router } from 'express'
import { query } from '../../db/query.js'
import { authMiddleware } from '../../middleware/auth.js'
import { sendError } from '../../lib/httpError.js'

const router = Router()
router.use(authMiddleware)

// Map type nội bộ → taxonomy frontend (Logs.jsx: llm/image/video/voice/subtitle).
const TYPE_MAP = {
  llm: 'llm',
  vision: 'image',
  ocr: 'image',
  image: 'image',
  tts: 'voice',
  voice: 'voice',
  asr: 'subtitle',
  subtitle: 'subtitle',
  media: 'video',
  video: 'video',
}

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
    // Normalize về vocabulary frontend: status 'ok'→'success', type → category map
    // (type gốc giữ lại trong rawType để đối chiếu ProviderLog docs/02 §6).
    res.json(rows.map((r) => ({
      ...r,
      rawType: r.type,
      type: TYPE_MAP[r.type] || r.type,
      status: r.status === 'ok' ? 'success' : r.status,
    })))
  } catch (err) {
    console.error('Logs error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

export default router
