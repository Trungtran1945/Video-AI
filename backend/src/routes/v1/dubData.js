import { Router } from 'express'
import { query } from '../../db/query.js'
import { applyTranscriptEdits, getTranscriptSnapshot, TranscriptRevisionConflict, TranscriptValidationError } from '../../services/transcriptMutationService.js'
import { getOutputState } from '../../services/outputService.js'
import { authMiddleware } from '../../middleware/auth.js'
import { requireProjectOwner } from '../../middleware/projectAccess.js'
import { sendError, ERR } from '../../lib/httpError.js'

const router = Router()
router.use(authMiddleware)

const isDubMode = (mode) => {
  const m = String(mode || '').toUpperCase().replace('-', '_')
  return m === 'TRANSLATE_DUB'
}

function serializeSegment(row) {
  return {
    ...row,
    index: row.index_num,
    startSec: row.start_sec,
    endSec: row.end_sec,
    isTimeManuallyAdjusted: !!row.is_time_manually_adjusted,
    isTextManuallyEdited: !!row.is_text_manually_edited,
    isTranslationManuallyEdited: !!row.is_translation_manually_edited,
  }
}

function handleTranscriptError(res, error) {
  if (error instanceof TranscriptRevisionConflict) {
    return sendError(res, 409, ERR.REVISION_CONFLICT, 'Transcript đã được cập nhật ở nơi khác — vui lòng tải lại trước khi lưu', {
      currentRevision: error.currentRevision,
      revision: error.currentRevision,
    })
  }
  if (error instanceof TranscriptValidationError) {
    const code = error.code === 'OVERLAP_CONFLICT' ? ERR.OVERLAP_CONFLICT : ERR.VALIDATION
    return sendError(res, error.statusCode || 400, code, error.message, {
      field: error.field,
      conflicts: error.conflicts,
      errors: error.errors,
    })
  }
  if (error?.code === 'REVISION_REQUIRED') {
    return sendError(res, 400, ERR.VALIDATION, error.message, { field: 'revision' })
  }
  if (error?.code === 'DB_WRITE_QUEUE_FULL' || error?.code === 'DB_PERSISTENCE_BLOCKED') {
    return sendError(res, 503, error.code, 'Database write queue is busy', { retryAfterMs: error.retryAfterMs })
  }
  console.error('Transcript error:', error)
  return sendError(res, 500, 'INTERNAL_ERROR', 'Không lưu được transcript')
}

router.get('/style-presets', async (req, res) => {
  try {
    const rows = await query('SELECT slug, name, description FROM style_presets ORDER BY rowid ASC')
    res.json(rows)
  } catch (err) {
    console.error('Style presets error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

router.get('/projects/:id/transcript', requireProjectOwner, async (req, res) => {
  try {
    if (!isDubMode(req.project.mode)) {
      return sendError(res, 400, ERR.VALIDATION, 'Chỉ dự án TRANSLATE_DUB mới có transcript', { field: 'mode' })
    }
    const snapshot = await getTranscriptSnapshot(req.project.id)
    if (!snapshot) return sendError(res, 404, ERR.PROJECT_NOT_FOUND, 'Project not found')
    const outputState = await getOutputState(req.project.id)
    res.json({
      revision: Number(snapshot.project.transcript_version ?? 0),
      segments: snapshot.segments.map(serializeSegment),
      outputStale: outputState.outputStale,
    })
  } catch (err) {
    console.error('Transcript error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

router.put('/projects/:id/transcript', requireProjectOwner, async (req, res) => {
  try {
    if (!isDubMode(req.project.mode)) {
      return sendError(res, 400, ERR.VALIDATION, 'Chỉ dự án TRANSLATE_DUB mới có transcript', { field: 'mode' })
    }
    const incoming = Array.isArray(req.body?.segments) ? req.body.segments : []
    if (!incoming.length) return sendError(res, 400, ERR.VALIDATION, 'segments rỗng', { field: 'segments' })
    const result = await applyTranscriptEdits(req.project.id, incoming, req.body?.revision, {
      durationSec: req.project.target_duration_sec,
    })
    const outputState = await getOutputState(req.project.id)
    res.json({
      updated: result.updated,
      revision: result.revision,
      adjustedSegments: result.adjustedSegments,
      outputStale: outputState.outputStale,
      segments: (result.segments || []).map(serializeSegment),
    })
  } catch (err) {
    handleTranscriptError(res, err)
  }
})

export default router
