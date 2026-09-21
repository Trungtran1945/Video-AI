import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, insert, updateById, run } from '../../db/query.js'
import { authMiddleware, requireRole } from '../../middleware/auth.js'
import { requireProjectOwner } from '../../middleware/projectAccess.js'
import { runPipeline, isPipelineRunning, STAGES } from '../../pipeline/runner.js'
import { deleteProjectFiles, collectProjectKeys } from '../../services/projectCleanup.js'
import { cancelProjectUseCase } from '../../usecases/cancelProjectUseCase.js'
import { sendError, ERR } from '../../lib/httpError.js'
import { config } from '../../config.js'
import { projectDir, firstRunnableStage } from '../../pipeline/context.js'
import { TRANSLATION_VERSION, isCacheCompatible, parseProjectParams } from '../../lib/cacheKey.js'
import { hasHardTranslationError } from '../../pipeline/stages/dubTranslate.js'

const router = Router()
router.use(authMiddleware)

const MODES = ['SUMMARY', 'TRANSLATE_DUB']


const isDubMode = (mode) => {
  const m = String(mode || '').toUpperCase().replace('-', '_')
  return m === 'TRANSLATE_DUB'
}

// POST /api/v1/projects
router.post('/', async (req, res) => {
  try {
    const b = req.body || {}
    // Chuẩn hoá mode về UPPERCASE, chấp nhận lowercase ('translate_dub') từ client cũ
    const mode = String(b.mode || '').toUpperCase().replace('-', '_')
    if (!MODES.includes(mode)) {
      return sendError(res, 400, ERR.VALIDATION, 'mode must be SUMMARY or TRANSLATE_DUB', { field: 'mode' })
    }
    if (!b.title || !b.title.trim()) {
      return sendError(res, 400, ERR.VALIDATION, 'title is required', { field: 'title' })
    }
    if (!b.sourceVideoKey) {
      return sendError(res, 400, ERR.VALIDATION, 'sourceVideoKey is required', { field: 'sourceVideoKey' })
    }

    // Group 1: Copyright validation
    if (b.copyrightAcknowledged !== true) {
      return sendError(res, 400, ERR.COPYRIGHT_MISSING,
        'Bạn phải xác nhận quyền sử dụng nội dung nguồn trước khi tạo project',
        { field: 'copyrightAcknowledged' })
    }

    // Group 1: Concurrency limit check
    const running = await queryOne(
      `SELECT COUNT(*) as cnt FROM projects WHERE user_id = ? AND status = 'running'`,
      [req.user.id]
    )
    const runningCount = running?.cnt || 0
    const maxConcurrent = config.maxConcurrentProjectsPerUser
    let status = 'pending'
    if (runningCount >= maxConcurrent) {
      status = 'queued'
    }

    // Merge params phẳng của TRANSLATE_DUB vào params JSON (docs/02 Project.params)
    let params = b.params && typeof b.params === 'object' ? { ...b.params } : {}
    if (mode === 'TRANSLATE_DUB') {

      const presetSlug = b.stylePreset || params.stylePreset
      if (!presetSlug) {
        return sendError(res, 400, ERR.VALIDATION, 'stylePreset is required for TRANSLATE_DUB projects', { field: 'stylePreset' })
      }
      const preset = await queryOne('SELECT id, slug FROM style_presets WHERE slug = ?', [presetSlug])
      if (!preset) {
        return sendError(res, 400, ERR.VALIDATION, `Unknown stylePreset '${presetSlug}' — xem GET /style-presets`, { field: 'stylePreset' })
      }
      params.stylePreset = preset.slug
      params.sourceLanguage = b.sourceLanguage || params.sourceLanguage || 'auto'
      params.targetLanguage = b.targetLanguage || params.targetLanguage || 'vi'
      params.enableDubbing = Boolean(b.enableDubbing ?? params.enableDubbing ?? false)
      params.ocrMode = Boolean(b.ocrMode ?? params.ocrMode ?? false)
      if (params.enableDubbing && !b.voiceId && !params.voiceProvider && !params.voiceName) {
        // voice tuỳ chọn — chỉ cảnh báo qua log, không chặn tạo dự án
        console.warn('[Projects] TRANSLATE_DUB enableDubbing=true nhưng chưa chọn voice; dùng voice mặc định của provider')
      }
      params.voiceId = b.voiceId || params.voiceId || null

      params.outputFormat = ['mp4', 'mkv'].includes(b.outputFormat) ? b.outputFormat : 'mp4'
      params.translationVersion = TRANSLATION_VERSION
    }

    // Calculate expires_at based on retention policy
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + config.projectRetentionDays)
    const now = new Date().toISOString()

    const project = await insert('projects', {
      id: uuidv4(),
      user_id: req.user.id,
      mode,
      title: b.title.trim(),
      status,
      language: b.language || (mode === 'TRANSLATE_DUB' ? (params.targetLanguage || 'vi') : 'vi'),
      style: b.style || (mode === 'SUMMARY' ? 'cinematic' : (params.stylePreset || null)),
      target_duration_sec: Number(b.targetDurationSec) || (mode === 'SUMMARY' ? 1500 : 60),
      aspect_ratio: b.aspectRatio || '16:9',
      params: JSON.stringify(params),
      source_video_key: b.sourceVideoKey || null,
      template_video_key: null, // legacy STYLE_EDIT — ngừng ghi (docs/00 §2.2)
      copyright_acknowledged: 1,
      copyright_ack_at: now,
      expires_at: expiresAt.toISOString(),
      video_hash: b.videoHash || null,
    })

    // Cache lookup (Task 1 fix): SAU insert, TRƯỚC runPipeline.
    // Query completed TRANSLATE_DUB cùng user + video_hash, lọc bằng
    // isCacheCompatible trong JS (so nhiều JSON field + version).
    let cachedProjectId = null
    let transcriptOnlySourceId = null
    if (b.videoHash && mode === 'TRANSLATE_DUB') {
      const candidates = await query(
        `SELECT id, params FROM projects
         WHERE user_id = ? AND video_hash = ? AND mode = 'TRANSLATE_DUB'
         AND status = 'completed' AND id != ?
         ORDER BY created_date DESC LIMIT 10`,
        [req.user.id, b.videoHash, project.id]
      )
      const newIdentity = {
        videoHash: b.videoHash,
        sourceLanguage: params.sourceLanguage || 'auto',
        targetLanguage: params.targetLanguage || 'vi',
        stylePreset: params.stylePreset,
        ocrMode: params.ocrMode,
        translationVersion: TRANSLATION_VERSION,
      }
      for (const c of candidates) {
        const cachedParams = { ...parseProjectParams(c.params), videoHash: b.videoHash }
        if (isCacheCompatible(newIdentity, cachedParams)) {
          cachedProjectId = c.id
          break
        }
      }
      if (!cachedProjectId) {
        // Transcript-only reuse: cùng video + sourceLanguage + ocrMode
        // (không phụ thuộc style/target/version) → copy text/timing với
        // translation=NULL để dub.translate chạy lại.
        const normLang = (v, d) => String(v ?? d).toLowerCase().trim()
        for (const c of candidates) {
          const cp = parseProjectParams(c.params)
          const sameSource = normLang(cp.sourceLanguage, 'auto') === normLang(params.sourceLanguage, 'auto')
          const sameOcr = Boolean(cp.ocrMode) === Boolean(params.ocrMode)
          if (sameSource && sameOcr) {
            transcriptOnlySourceId = c.id
            break
          }
        }
      }
    }

    // Copy transcript segments — check COUNT==0 trước insert để không duplicate.
    // cachedProjectId → copy kèm translation; transcript-only → translation=NULL.
    const copySourceId = cachedProjectId || transcriptOnlySourceId
    if (copySourceId) {
      const existingCount = await queryOne(
        'SELECT COUNT(*) as cnt FROM transcript_segments WHERE project_id = ?',
        [project.id]
      )
      if ((existingCount?.cnt || 0) === 0) {
        const transcriptSegments = await query('SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC', [copySourceId])
        for (const s of transcriptSegments) {
          await insert('transcript_segments', {
            id: uuidv4(),
            project_id: project.id,
            index_num: s.index_num,
            start_sec: s.start_sec,
            end_sec: s.end_sec,
            text: s.text,
            speaker: s.speaker,
            language: s.language,
            translation: cachedProjectId ? s.translation : null,
          })
        }
      }
    }

    // Kick off the real pipeline asynchronously — LUÔN CUỐI CÙNG, sau khi
    // copy cache xong (tránh race: stage skip-if-exists đọc nhầm bảng rỗng
    // hoặc ghi đè song song với copy).
    if (status === 'pending') {
      runPipeline(project.id).catch((e) => console.error('[Pipeline] start failed', e))
    }

    res.status(202).json({ ...project, params, cachedProjectId })
  } catch (err) {
    console.error('Create project error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// GET /api/v1/projects — filter ?mode=, phân trang tuỳ chọn ?page&limit (docs/06 §2).
// Không truyền page/limit → trả full array (tương thích frontend hiện tại).
router.get('/', async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin'
    let sql = 'SELECT * FROM projects'
    const params = []
    if (!isAdmin) {
      sql += ' WHERE user_id = ?'
      params.push(req.user.id)
    }
    if (req.query.mode) {
      sql += (params.length ? ' AND' : ' WHERE') + ' mode = ?'
      params.push(String(req.query.mode).toUpperCase().replace('-', '_'))
    }
    sql += ' ORDER BY created_date DESC'
    const limit = Number(req.query.limit)
    const page = Number(req.query.page)
    const hasPaging = Number.isInteger(limit) && limit > 0
    if (hasPaging) {
      sql += ' LIMIT ? OFFSET ?'
      params.push(limit, Number.isInteger(page) && page > 1 ? (page - 1) * limit : 0)
    }
    const rows = await query(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('List projects error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// GET /api/v1/projects/:id (with jobs, timeline, output, extras)
router.get('/:id', async (req, res) => {
  try {
    const project = await queryOne('SELECT * FROM projects WHERE id = ?', [req.params.id])
    if (!project) return sendError(res, 404, ERR.PROJECT_NOT_FOUND, 'Project not found')
    if (project.user_id !== req.user.id && req.user.role !== 'admin') {
      return sendError(res, 403, ERR.AUTH_FORBIDDEN, 'Forbidden')
    }
    const jobs = await query('SELECT * FROM generation_jobs WHERE project_id = ? ORDER BY created_date ASC', [project.id])
    const timeline = await query('SELECT * FROM timeline_clips WHERE project_id = ? ORDER BY order_index ASC', [project.id])
    const output = await queryOne('SELECT * FROM outputs WHERE project_id = ? ORDER BY created_date DESC LIMIT 1', [project.id])
    let extras = {}
    if (project.mode === 'SUMMARY') {
      extras.scenes = await query('SELECT * FROM scenes WHERE project_id = ? ORDER BY start_sec ASC', [project.id])
      extras.scriptSegments = await query('SELECT * FROM script_segments WHERE project_id = ? ORDER BY index_num ASC', [project.id])
    } else if (isDubMode(project.mode)) {
      // TRANSLATE_DUB mode - no extra data needed
    }
    res.json({ ...project, params: project.params ? JSON.parse(project.params) : null, jobs, timeline, output, ...extras })
  } catch (err) {
    console.error('Get project error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// GET /api/v1/projects/:id/timeline
router.get('/:id/timeline', requireProjectOwner, async (req, res) => {
  const timeline = await query('SELECT * FROM timeline_clips WHERE project_id = ? ORDER BY order_index ASC', [req.params.id])
  res.json(timeline)
})

// PATCH /api/v1/projects/:id/segments/:segmentId/translation — quarantine sửa tay.
// Khi dub.translate fail TRANSLATE_NEEDS_REVIEW, details nằm ở job.result;
// user sửa từng segment unresolved ở đây rồi regenerate từ dub.translate
// (skip-if-translated giữ lại bản sửa tay). Gate hard phải PASS (422 nếu còn
// lỗi nặng); soft warnings cho qua như pipeline.
router.patch('/:id/segments/:segmentId/translation', requireProjectOwner, async (req, res) => {
  try {
    const { segmentId } = req.params
    const translation = String(req.body?.translation ?? '').trim()
    if (!translation) return sendError(res, 400, ERR.VALIDATION, 'translation is required', { field: 'translation' })
    const seg = await queryOne(
      'SELECT * FROM transcript_segments WHERE id = ? AND project_id = ?',
      [segmentId, req.project.id]
    )
    if (!seg) return sendError(res, 404, ERR.VALIDATION, 'Segment not found in this project', { field: 'segmentId' })
    const params = parseProjectParams(req.project.params)
    const gate = hasHardTranslationError(seg.text, translation, params.targetLanguage || 'vi')
    if (gate.hard) {
      return sendError(res, 422, ERR.VALIDATION, `Bản dịch vẫn lỗi gate: ${(gate.errors || []).join('; ')}`, {
        field: 'translation',
        errors: gate.errors || [],
      })
    }
    if ((gate.errors || []).length) {
      console.warn(`[Projects] manual translation segment #${seg.index_num} soft warnings (allowed): ${gate.errors.join(';')}`)
    }
    await updateById('transcript_segments', seg.id, { translation, tts_audio_id: null })
    const updated = await queryOne('SELECT * FROM transcript_segments WHERE id = ?', [seg.id])
    res.json({ ...updated, warnings: gate.errors || [] })
  } catch (err) {
    console.error('Update segment translation error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// POST /api/v1/projects/:id/cancel — FR-J1: Cancel running pipeline
router.post('/:id/cancel', requireProjectOwner, async (req, res) => {
  try {
    const project = await cancelProjectUseCase(req.params.id)
    res.json(project)
  } catch (err) {
    console.error('Cancel project error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', err.message || 'Internal server error')
  }
})

// POST /api/v1/projects/:id/regenerate — rerun pipeline from the earliest
// incomplete stage in pipeline order (or from scratch when everything
// succeeded). Idempotent: the pipeline clears derived rows before rewriting
// them. Resuming strictly from the first FAILED job would skip pending/retry
// predecessors and BLOCK_RENDER-fail downstream (e.g. render while ttsAlign
// never ran), so resume follows stage order via firstRunnableStage.
router.post('/:id/regenerate', requireProjectOwner, async (req, res) => {
  const project = req.project
  const jobs = await query(
    `SELECT type, status, next_retry_at FROM generation_jobs WHERE project_id = ?`,
    [project.id]
  )
  const r = firstRunnableStage(STAGES[project.mode] || [], jobs)
  if (r.waiting) {
    return sendError(res, 429, 'RETRY_WAITING', `Stage ${r.type} đang chờ quota hồi phục, thử lại sau ${new Date(r.nextRetryAt).toLocaleTimeString('vi-VN')}`, {
      stage: r.type,
      nextRetryAt: r.nextRetryAt,
    })
  }
  runPipeline(project.id, r.type).catch(() => {})
  res.json({ message: 'Pipeline restarted', status: 'running', ...(r.type ? { fromStage: r.type } : {}) })
})

// DELETE /api/v1/projects/:id
router.delete('/:id', async (req, res) => {
  try {
    const project = await queryOne('SELECT * FROM projects WHERE id = ?', [req.params.id])
    if (!project) return sendError(res, 404, ERR.PROJECT_NOT_FOUND, 'Project not found')
    if (project.user_id !== req.user.id && req.user.role !== 'admin') {
      return sendError(res, 403, ERR.AUTH_FORBIDDEN, 'Forbidden')
    }
    // Deleting mid-run would leave the pipeline writing into removed folders/rows.
    if (isPipelineRunning(project.id)) {
      return sendError(res, 409, 'PIPELINE_RUNNING', 'Pipeline đang chạy, hãy đợi hoàn tất hoặc thất bại rồi mới xoá được dự án')
    }
    // Collect file references BEFORE wiping rows — afterwards the queries
    // would find nothing and uploads/outputs files would be orphaned.
    const fileKeys = await collectProjectKeys(project)
    // ProviderLog is independent of the project lifecycle (docs/02 §5):
    // keep the rows for analytics, only detach them from the deleted project.
    await run('UPDATE provider_logs SET project_id = NULL WHERE project_id = ?', [req.params.id])
    await run(`DELETE FROM youtube_uploads WHERE output_id IN (SELECT id FROM outputs WHERE project_id = ?)`, [req.params.id])
    for (const t of ['generation_jobs', 'assets', 'scenes', 'script_segments', 'transcript_segments', 'ocr_regions', 'timeline_clips', 'audios', 'subtitles', 'outputs']) {
      await run(`DELETE FROM ${t} WHERE project_id = ?`, [req.params.id])
    }
    await run('DELETE FROM projects WHERE id = ?', [req.params.id])
    // DB rows are gone — now free the files. Best-effort: a stuck file handle
    // should not fail an already-committed deletion, orphan files are logged.
    const cleanup = await deleteProjectFiles(project, fileKeys)
    if (cleanup.filesFailed > 0) {
      console.warn(`[Projects] xoá ${req.params.id}: ${cleanup.filesFailed} tệp không xoá được khỏi storage`)
    }
    res.json({ message: 'Deleted' })
  } catch (err) {
    console.error('Delete project error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

export default router
