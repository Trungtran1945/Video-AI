import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { query, run } from '../../db/query.js'
import { authMiddleware } from '../../middleware/auth.js'
import { requireProjectOwner } from '../../middleware/projectAccess.js'
import { sendError, ERR } from '../../lib/httpError.js'

const router = Router()
router.use(authMiddleware)

const isDubMode = (mode) => {
  const m = String(mode || '').toUpperCase().replace('-', '_')
  return m === 'TRANSLATE_DUB'
}

// GET /api/v1/style-presets — danh mục 12 phong cách dịch (docs/06 §3).
router.get('/style-presets', async (req, res) => {
  try {
    const rows = await query('SELECT slug, name, description FROM style_presets ORDER BY rowid ASC')
    res.json(rows)
  } catch (err) {
    console.error('Style presets error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// GET /api/v1/projects/:id/transcript — TranscriptSegment[] + bản dịch (docs/06 §2).
router.get('/projects/:id/transcript', requireProjectOwner, async (req, res) => {
  try {
    if (!isDubMode(req.project.mode)) {
      return sendError(res, 400, ERR.VALIDATION, 'Chỉ dự án TRANSLATE_DUB mới có transcript', { field: 'mode' })
    }
    const rows = await query(
      `SELECT id, index_num, start_sec, end_sec, text, speaker, language, translation
       FROM transcript_segments WHERE project_id = ?
       ORDER BY index_num ASC`,
      [req.project.id]
    )
    // Trả song song camelCase (contract frontend) lẫn snake_case (legacy)
    res.json(rows.map((r) => ({
      ...r,
      index: r.index_num,
      startSec: r.start_sec,
      endSec: r.end_sec,
    })))
  } catch (err) {
    console.error('Transcript error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// GET /api/v1/projects/:id/mask-regions — OcrRegion[] (AUTO từ OCR + MANUAL từ Canvas)
router.get('/projects/:id/mask-regions', requireProjectOwner, async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM ocr_regions WHERE project_id = ? ORDER BY start_sec ASC`,
      [req.project.id]
    )
    res.json(rows.map((r) => ({
      ...r,
      startSec: r.start_sec,
      endSec: r.end_sec,
    })))
  } catch (err) {
    console.error('Mask regions error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// PUT /api/v1/projects/:id/transcript — lưu bản dịch đã chỉnh sửa của user.
// Chỉ cập nhật cột `translation` (giữ nguyên text gốc & timing). Dùng trước
// khi "Chạy lại (lồng tiếng)" để áp dụng chỉnh sửa vào video.
// Body: { segments: [{ id, translation }] }
router.put('/projects/:id/transcript', requireProjectOwner, async (req, res) => {
  try {
    if (!isDubMode(req.project.mode)) {
      return sendError(res, 400, ERR.VALIDATION, 'Chỉ dự án TRANSLATE_DUB mới có transcript', { field: 'mode' })
    }
    const incoming = Array.isArray(req.body?.segments) ? req.body.segments : []
    if (!incoming.length) return sendError(res, 400, ERR.VALIDATION, 'segments rỗng', { field: 'segments' })

    const existing = await query('SELECT id, translation FROM transcript_segments WHERE project_id = ?', [req.project.id])
    const existingIds = new Set(existing.map((r) => String(r.id)))
    let updated = 0
    for (const s of incoming) {
      if (!s || typeof s !== 'object') continue
      const id = String(s.id)
      if (!existingIds.has(id)) continue
      const translation = typeof s.translation === 'string' ? s.translation : null
      await run(`UPDATE transcript_segments SET translation = ? WHERE id = ? AND project_id = ?`, [translation, id, req.project.id])
      updated++
    }

    const rows = await query(
      `SELECT id, index_num, start_sec, end_sec, text, speaker, language, translation
       FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC`,
      [req.project.id]
    )
    res.json({
      updated,
      segments: rows.map((r) => ({ ...r, index: r.index_num, startSec: r.start_sec, endSec: r.end_sec })),
    })
  } catch (err) {
    console.error('Transcript PUT error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

const NUM = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

// PUT /api/v1/projects/:id/mask-regions — lưu vùng che sau khi user chỉnh trên Canvas.
// Body: { regions: [{id?, startSec, endSec, x, y, width, height, source?}] }
// Ngữ nghĩa upsert:
// - id khớp region đã có của project → cập nhật toạ độ/thời gian (giữ nguyên source gốc)
// - id mới (tmp_...) → thêm mới với source='MANUAL'
router.put('/projects/:id/mask-regions', requireProjectOwner, async (req, res) => {
  try {
    const regions = Array.isArray(req.body?.regions) ? req.body.regions : []

    const existing = await query('SELECT * FROM ocr_regions WHERE project_id = ?', [req.project.id])
    const existingIds = new Set(existing.map((r) => r.id))
    const incomingIds = new Set()

    let updated = 0
    let inserted = 0
    for (const r of regions) {
      if (!r || typeof r !== 'object') continue
      const values = [
        NUM(r.startSec ?? r.start_sec),
        NUM(r.endSec ?? r.end_sec),
        Math.round(NUM(r.x)),
        Math.round(NUM(r.y)),
        Math.round(NUM(r.width)),
        Math.round(NUM(r.height)),
      ]
      if (r.id && existingIds.has(String(r.id))) {
        // Cập nhật geometry/time cho region đã có (AUTO hoặc MANUAL)
        await run(
          `UPDATE ocr_regions SET start_sec = ?, end_sec = ?, x = ?, y = ?, width = ?, height = ? WHERE id = ? AND project_id = ?`,
          [...values, String(r.id), req.project.id]
        )
        incomingIds.add(String(r.id))
        updated++
      } else {
        await run(
          `INSERT INTO ocr_regions (id, project_id, start_sec, end_sec, x, y, width, height, text, confidence, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [String(r.id || uuidv4()), req.project.id, ...values, r.text || null, null, 'MANUAL']
        )
        inserted++
      }
    }

    // Xoá MANUAL cũ không còn được client giữ lại (user đã xoá trên Canvas)
    for (const row of existing) {
      if (row.source === 'MANUAL' && !incomingIds.has(row.id)) {
        await run(`DELETE FROM ocr_regions WHERE id = ?`, [row.id])
      }
    }

    const all = await query(`SELECT * FROM ocr_regions WHERE project_id = ? ORDER BY start_sec ASC`, [req.project.id])
    res.json({ updated, insertedManual: inserted, regions: all })
  } catch (err) {
    console.error('Mask regions PUT error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

export default router
