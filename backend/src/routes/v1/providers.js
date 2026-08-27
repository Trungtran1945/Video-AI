import { Router } from 'express'
import { query } from '../../db/query.js'
import { authMiddleware } from '../../middleware/auth.js'
import { sendError } from '../../lib/httpError.js'

const router = Router()
router.use(authMiddleware)

// GET /api/v1/providers — danh mục provider + health status (docs/06 §5).
// Health = tỉ lệ thành công gần đây từ provider_logs; hasKey = user đã lưu API key.
router.get('/', async (req, res) => {
  try {
    let stats = []
    let keys = []
    try {
      stats = await query(
        `SELECT provider,
                COUNT(*) as calls,
                SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as ok_calls
         FROM provider_logs
         WHERE created_date >= datetime('now', '-30 days')
         GROUP BY provider`
      )
    } catch (_) { /* bảng trống/chưa có cột created_date → bỏ qua health */ }
    try {
      keys = await query('SELECT DISTINCT provider FROM api_keys WHERE user_id = ? AND is_active = 1', [req.user.id])
    } catch (_) {}
    const statMap = new Map(stats.map((s) => [s.provider, s]))
    const keySet = new Set(keys.map((k) => k.provider))

    const decorate = (id, available) => {
      const s = statMap.get(id)
      const calls = Number(s?.calls || 0)
      const okCalls = Number(s?.ok_calls || 0)
      return {
        id,
        available: available !== false,
        hasKey: keySet.has(id),
        health: calls > 0
          ? { calls, successRate: Math.round((okCalls / calls) * 100), last30d: true }
          : { calls: 0, successRate: null, last30d: false },
      }
    }

    res.json({
      llm: [
        decorate('gemini'),
        decorate('openai'),
        decorate('anthropic'),
        decorate('huggingface'),
      ],
      asr: [
        decorate('whisper'),
        decorate('faster_whisper', false),
        decorate('openai_whisper'),
      ],
      tts: [
        decorate('elevenlabs'),
        decorate('google_tts', false),
        decorate('azure_speech', false),
        decorate('openai_tts'),
      ],
      vision: [
        decorate('gemini'),
        decorate('clip', false),
      ],
      video: [
        decorate('kling', false),
        decorate('hailuo', false),
        decorate('pixverse', false),
        decorate('runway', false),
        decorate('luma', false),
      ],
    })
  } catch (err) {
    console.error('Providers error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

export default router
