import { Router } from 'express'
import { query, queryOne, run } from '../../db/query.js'
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
      `SELECT id, index_num, start_sec, end_sec, text, speaker, language, translation,
              is_time_manually_adjusted, is_text_manually_edited, is_translation_manually_edited
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
      isTimeManuallyAdjusted: !!r.is_time_manually_adjusted,
      isTextManuallyEdited: !!r.is_text_manually_edited,
      isTranslationManuallyEdited: !!r.is_translation_manually_edited,
    })))
  } catch (err) {
    console.error('Transcript error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// PUT /api/v1/projects/:id/transcript — lưu bản chỉnh sửa của user (source of truth §8).
// Hỗ trợ chỉnh sửa source text + translation + timing với overlap detection (docs/03 §3, VAL_002).
// Body: { segments: [{ id, text?, translation?, startSec?, endSec? }] }
// - text đổi mà payload không kèm translation → translation=NULL + flag tay reset
//   (bản dịch cũ đã stale, dub.translate sẽ dịch lại; không overwrite ngầm).
// - translation kèm theo → flag is_translation_manually_edited=1 (AI không ghi đè).
router.put('/projects/:id/transcript', requireProjectOwner, async (req, res) => {
  try {
    if (!isDubMode(req.project.mode)) {
      return sendError(res, 400, ERR.VALIDATION, 'Chỉ dự án TRANSLATE_DUB mới có transcript', { field: 'mode' })
    }
    const incoming = Array.isArray(req.body?.segments) ? req.body.segments : []
    if (!incoming.length) return sendError(res, 400, ERR.VALIDATION, 'segments rỗng', { field: 'segments' })

    // Load all segments ordered by index_num for overlap detection
    const allSegments = await query(
      'SELECT id, index_num, start_sec, end_sec, text, translation, is_time_manually_adjusted, is_text_manually_edited, is_translation_manually_edited FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC',
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

      // Update the segment — user edit là source of truth (§7, §8).
      const hasTextKey = s.text !== undefined
      const hasTranslationKey = s.translation !== undefined
      const newText = typeof s.text === 'string' ? s.text : seg.text
      const textChanged = hasTextKey && typeof s.text === 'string' && s.text !== seg.text
      let newTranslation
      let newTextEdited = seg.is_text_manually_edited
      let newTranslationEdited = seg.is_translation_manually_edited
      if (textChanged) {
        newTextEdited = 1
        if (!hasTranslationKey || s.translation === undefined) {
          // Text mới + không kèm translation → bản dịch cũ stale, clear để
          // dub.translate dịch lại thay vì giữ bản dịch của text cũ.
          newTranslation = null
          newTranslationEdited = 0
        } else {
          newTranslation = typeof s.translation === 'string' ? s.translation : null
          newTranslationEdited = newTranslation !== null ? 1 : 0
        }
      } else if (hasTranslationKey) {
        newTranslation = typeof s.translation === 'string' ? s.translation : null
        newTranslationEdited = newTranslation !== null ? 1 : 0
      } else {
        newTranslation = seg.translation
      }
      await run(
        `UPDATE transcript_segments SET text = ?, translation = ?, start_sec = ?, end_sec = ?, is_time_manually_adjusted = ?, is_text_manually_edited = ?, is_translation_manually_edited = ? WHERE id = ? AND project_id = ?`,
        [newText, newTranslation, newStart, newEnd, hasTimingChange ? 1 : seg.is_time_manually_adjusted, newTextEdited, newTranslationEdited, id, req.project.id]
      )
      // Sửa tay text/translation → audio TTS cũ (nếu có) đã stale, tổng hợp lại.
      if (textChanged || newTranslation !== seg.translation) {
        await run(`UPDATE transcript_segments SET tts_audio_id = NULL WHERE id = ?`, [id])
      }
      updated++
    }

    const rows = await query(
      `SELECT id, index_num, start_sec, end_sec, text, speaker, language, translation, is_time_manually_adjusted, is_text_manually_edited, is_translation_manually_edited
       FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC`,
      [req.project.id]
    )
    // PUT không trigger TTS/render — chỉ đánh dấu output hiện tại đã stale
    // để frontend hiển thị "cần redub".
    const latestOutput = await queryOne(
      `SELECT * FROM outputs WHERE project_id = ? ORDER BY created_date DESC LIMIT 1`,
      [req.project.id]
    )
    res.json({
      updated,
      adjustedSegments,
      outputStale: !!latestOutput,
      segments: rows.map((r) => ({
        ...r,
        index: r.index_num,
        startSec: r.start_sec,
        endSec: r.end_sec,
        isTimeManuallyAdjusted: !!r.is_time_manually_adjusted,
        isTextManuallyEdited: !!r.is_text_manually_edited,
        isTranslationManuallyEdited: !!r.is_translation_manually_edited,
      })),
    })
  } catch (err) {
    console.error('Transcript PUT error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', err.message || 'Internal server error')
  }
})

export default router
