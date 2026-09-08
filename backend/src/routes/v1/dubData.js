import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { query, run } from '../../db/query.js'
import { authMiddleware } from '../../middleware/auth.js'
import { requireProjectOwner } from '../../middleware/projectAccess.js'
import { sendError, ERR } from '../../lib/httpError.js'
import { normalizeRegion } from '../../media/mediaService.js'

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
    res.json(rows.map((r) => normalizeRegion(r)))
  } catch (err) {
    console.error('Mask regions error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// PUT /api/v1/projects/:id/transcript — lưu bản dịch đã chỉnh sửa của user.
// Hỗ trợ chỉnh sửa timing với overlap detection (docs/03 §3, VAL_002).
// Body: { segments: [{ id, translation?, startSec?, endSec? }] }
router.put('/projects/:id/transcript', requireProjectOwner, async (req, res) => {
  try {
    if (!isDubMode(req.project.mode)) {
      return sendError(res, 400, ERR.VALIDATION, 'Chỉ dự án TRANSLATE_DUB mới có transcript', { field: 'mode' })
    }
    const incoming = Array.isArray(req.body?.segments) ? req.body.segments : []
    if (!incoming.length) return sendError(res, 400, ERR.VALIDATION, 'segments rỗng', { field: 'segments' })

    // Load all segments ordered by index_num for overlap detection
    const allSegments = await query(
      'SELECT id, index_num, start_sec, end_sec, is_time_manually_adjusted FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC',
      [req.project.id]
    )
    const segmentMap = new Map(allSegments.map((r) => [r.id, r]))
    const adjustedSegments = []
    let updated = 0

    for (const s of incoming) {
      if (!s || typeof s !== 'object') continue
      const id = String(s.id)
      const seg = segmentMap.get(id)
      if (!seg) continue

      let newStart = Number.isFinite(Number(s.startSec)) ? Number(s.startSec) : seg.start_sec
      let newEnd = Number.isFinite(Number(s.endSec)) ? Number(s.endSec) : seg.end_sec
      const hasTimingChange = newStart !== seg.start_sec || newEnd !== seg.end_sec

      // Overlap detection for timing changes
      if (hasTimingChange) {
        const idx = allSegments.findIndex((r) => r.id === id)
        const GAP = 0.1 // minimum allowed gap between segments

        // Rule 1: Check overlap with previous segment (N-1)
        if (idx > 0) {
          const prev = allSegments[idx - 1]
          if (prev.end_sec - GAP > newStart) {
            return sendError(res, 400, ERR.OVERLAP_CONFLICT,
              `Overlap detected: segment trước (index ${prev.index_num}) kết thúc lúc ${prev.end_sec}s, segment này bắt đầu lúc ${newStart}s. Chênh lệch tối thiểu ${GAP}s.`,
              { code: ERR.OVERLAP_CONFLICT, prevSegmentId: prev.id, prevEnd: prev.end_sec, newStart })
          }
        }

        // Rule 2 & 3: Auto-push downstream segments if needed
        const delta = (newEnd - seg.end_sec)
        if (delta > 0) {
          // Check downstream segments for overlap
          for (let j = idx + 1; j < allSegments.length; j++) {
            const next = allSegments[j]
            const nextNewStart = next.start_sec + delta
            const nextNewEnd = next.end_sec + delta

            // Rule 3: If next segment has isTimeManuallyAdjusted=true, reject
            if (next.is_time_manually_adjusted) {
              if (nextNewStart < newEnd + GAP) {
                return sendError(res, 400, ERR.OVERLAP_CONFLICT,
                  `Conflict with manually adjusted segment (index ${next.index_num}). Please adjust manually.`,
                  { code: ERR.OVERLAP_CONFLICT, conflictSegmentId: next.id })
              }
              break // No need to check further
            }

            // Rule 2: Auto-push if not manually adjusted
            const overlap = next.start_sec < newEnd + GAP
            if (overlap || delta > 0) {
              // Push this segment and all subsequent ones
              for (let k = j; k < allSegments.length; k++) {
                const pushSeg = allSegments[k]
                const pushDelta = delta
                await run(
                  `UPDATE transcript_segments SET start_sec = start_sec + ?, end_sec = end_sec + ?, is_time_manually_adjusted = 0 WHERE id = ?`,
                  [pushDelta, pushDelta, pushSeg.id]
                )
                adjustedSegments.push({
                  id: pushSeg.id,
                  index: pushSeg.index_num,
                  prevStart: pushSeg.start_sec,
                  prevEnd: pushSeg.end_sec,
                  newStart: pushSeg.start_sec + pushDelta,
                  newEnd: pushSeg.end_sec + pushDelta,
                })
                // Update in-memory map
                pushSeg.start_sec += pushDelta
                pushSeg.end_sec += pushDelta
              }
              break
            }
          }
        }
      }

      // Update the segment
      const translation = typeof s.translation === 'string' ? s.translation : null
      await run(
        `UPDATE transcript_segments SET translation = ?, start_sec = ?, end_sec = ?, is_time_manually_adjusted = ? WHERE id = ? AND project_id = ?`,
        [translation, newStart, newEnd, hasTimingChange ? 1 : seg.is_time_manually_adjusted, id, req.project.id]
      )
      updated++
    }

    const rows = await query(
      `SELECT id, index_num, start_sec, end_sec, text, speaker, language, translation, is_time_manually_adjusted
       FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC`,
      [req.project.id]
    )
    res.json({
      updated,
      adjustedSegments,
      segments: rows.map((r) => ({
        ...r,
        index: r.index_num,
        startSec: r.start_sec,
        endSec: r.end_sec,
        isTimeManuallyAdjusted: !!r.is_time_manually_adjusted,
      })),
    })
  } catch (err) {
    console.error('Transcript PUT error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', err.message || 'Internal server error')
  }
})

const NUM = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

// PUT /api/v1/projects/:id/mask-regions — lưu vùng che sau khi user chỉnh trên Canvas.
// Body: { regions: [{id?, startSec, endSec, ratioX, ratioY, ratioW, ratioH, maskStrength?, isStatic?, source?}] }
// Toạ độ LƯU TỶ LỆ (ratioX/Y/W/H 0..1, scale-invariant). Ngữ nghĩa upsert:
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
      // clamp tỷ lệ về [0,1]
      const clamp01 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0 }
      const ratioX = clamp01(r.ratioX ?? r.ratio_x)
      const ratioY = clamp01(r.ratioY ?? r.ratio_y)
      const ratioW = clamp01(r.ratioW ?? r.ratio_w)
      const ratioH = clamp01(r.ratioH ?? r.ratio_h)
      const maskStrength = Math.min(1, Math.max(0, NUM(r.maskStrength ?? r.mask_strength ?? 0.6)))
      const isStatic = r.isStatic ?? r.is_static ? 1 : 0
      const startSec = NUM(r.startSec ?? r.start_sec)
      // isStatic → trải dài toàn bộ video (backend sẽ nhân endSec với duration khi render)
      const endSec = isStatic ? NUM(r.endSec ?? r.end_sec) : NUM(r.endSec ?? r.end_sec)
      const values = [startSec, endSec, ratioX, ratioY, ratioW, ratioH, maskStrength, isStatic]
      if (r.id && existingIds.has(String(r.id))) {
        // Cập nhật geometry/time cho region đã có (AUTO hoặc MANUAL)
        await run(
          `UPDATE ocr_regions SET start_sec = ?, end_sec = ?, ratio_x = ?, ratio_y = ?, ratio_w = ?, ratio_h = ?, mask_strength = ?, is_static = ? WHERE id = ? AND project_id = ?`,
          [...values, String(r.id), req.project.id]
        )
        incomingIds.add(String(r.id))
        updated++
      } else {
        await run(
          `INSERT INTO ocr_regions (id, project_id, start_sec, end_sec, ratio_x, ratio_y, ratio_w, ratio_h, mask_strength, is_static, text, confidence, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    res.json({ updated, insertedManual: inserted, regions: all.map((r) => normalizeRegion(r)) })
  } catch (err) {
    console.error('Mask regions PUT error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

export default router
