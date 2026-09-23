import { Router } from 'express'
import { query, queryOne } from '../../db/query.js'
import { withTransaction } from '../../db/query.js'
import { computeProposedState, validateProposedState, TIMING_GAP } from '../../lib/transcriptTiming.js'
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
// Atomic + deterministic: tính toàn bộ proposed state trong memory (minimal-push,
// chỉ đẩy downstream khi overlap, giữ gap thừa), validate hết rồi mới commit một
// transaction duy nhất. Bất kỳ lỗi nào → không ghi DB.
router.put('/projects/:id/transcript', requireProjectOwner, async (req, res) => {
  try {
    if (!isDubMode(req.project.mode)) {
      return sendError(res, 400, ERR.VALIDATION, 'Chỉ dự án TRANSLATE_DUB mới có transcript', { field: 'mode' })
    }
    const incoming = Array.isArray(req.body?.segments) ? req.body.segments : []
    if (!incoming.length) return sendError(res, 400, ERR.VALIDATION, 'segments rỗng', { field: 'segments' })

    // Load all segments ordered by index_num for proposed-state computation
    const allSegments = await query(
      'SELECT id, index_num, start_sec, end_sec, text, translation, is_time_manually_adjusted, is_text_manually_edited, is_translation_manually_edited FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC',
      [req.project.id]
    )
    if (!allSegments.length) return sendError(res, 400, ERR.VALIDATION, 'Không có transcript để sửa', { field: 'segments' })
    const durationSec = Number.isFinite(Number(req.project?.target_duration_sec))
      ? Number(req.project.target_duration_sec)
      : null

    // 1-5. Proposed state trong memory (không ghi DB): apply text/translation/
    // timing explicit + minimal downstream push, deterministic theo index_num.
    const computed = computeProposedState(allSegments, incoming, { gap: TIMING_GAP, durationSec })
    if (computed.errors.length) {
      const first = computed.errors[0]
      const code = first.code === 'UNKNOWN_SEGMENT' ? ERR.VALIDATION : ERR.VALIDATION
      return sendError(res, 400, code, first.message, { ...first })
    }
    if (computed.conflicts.length) {
      const first = computed.conflicts[0]
      return sendError(res, 400, ERR.OVERLAP_CONFLICT, first.message, { ...first, conflicts: computed.conflicts })
    }
    // 6. Validate toàn bộ proposed state (overlap/âm/duration).
    const validation = validateProposedState(computed.ordered, { gap: TIMING_GAP, durationSec })
    if (!validation.ok) {
      const first = validation.errors[0]
      const code = first.code === 'OVERLAP_CONFLICT' ? ERR.OVERLAP_CONFLICT : ERR.VALIDATION
      return sendError(res, 400, code, first.message, { ...first, errors: validation.errors })
    }

    const origById = new Map(allSegments.map((r) => [String(r.id), r]))
    const explicitIds = new Set(
      incoming.filter((s) => s && typeof s === 'object' && origById.has(String(s.id))).map((s) => String(s.id))
    )
    const adjustedIds = new Set((computed.adjusted || []).map((a) => String(a.id)))
    const dirtyIds = new Set([...explicitIds, ...adjustedIds])
    const adjustedSegments = computed.adjusted || []
    const ttsInvalidate = new Set(computed.ttsInvalidate || [])

    // 7-9. Commit toàn bộ trong một transaction duy nhất; fail → rollback hết.
    try {
      await withTransaction(async (tx) => {
        for (const id of dirtyIds) {
          const row = computed.proposed.get(id)
          if (!row) continue
          const ttsNull = ttsInvalidate.has(id)
          await tx.run(
            `UPDATE transcript_segments SET text = ?, translation = ?, start_sec = ?, end_sec = ?, is_time_manually_adjusted = ?, is_text_manually_edited = ?, is_translation_manually_edited = ?${ttsNull ? ', tts_audio_id = NULL' : ''} WHERE id = ? AND project_id = ?`,
            [row.text, row.translation, row.start_sec, row.end_sec, row.is_time_manually_adjusted, row.is_text_manually_edited, row.is_translation_manually_edited, id, req.project.id]
          )
        }
      })
    } catch (txErr) {
      console.error('Transcript PUT transaction failed:', txErr)
      return sendError(res, 500, 'INTERNAL_ERROR', 'Không lưu được transcript (transaction rollback)')
    }
    const updated = explicitIds.size

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
