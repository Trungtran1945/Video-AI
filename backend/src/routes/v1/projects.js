import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, run, withTransaction } from '../../db/query.js'
import { createProjectWithAdmission, acquireProjectRun, updateProjectOwned } from '../../services/projectAdmission.js'
import { copyTranscript, updateSegmentTranslation, TranscriptRevisionConflict, TranscriptValidationError } from '../../services/transcriptMutationService.js'
import { getOutputState } from '../../services/outputService.js'
import { authMiddleware } from '../../middleware/auth.js'
import { requireProjectOwner } from '../../middleware/projectAccess.js'
import { runPipeline, isPipelineRunning, stagesForProject } from '../../pipeline/runner.js'
import { collectProjectKeys, runCleanupTask } from '../../services/projectCleanup.js'
import { cancelProjectUseCase } from '../../usecases/cancelProjectUseCase.js'
import { sendError, ERR } from '../../lib/httpError.js'
import { firstRunnableStage, projectDir, resolveStorageKey } from '../../pipeline/context.js'
import { TRANSLATION_VERSION, isCacheCompatible, parseProjectParams } from '../../lib/cacheKey.js'
import { computeProjectFingerprint } from '../../lib/idempotencyFingerprint.js'
import { hasHardTranslationError } from '../../pipeline/stages/dubTranslate.js'
import { listGlossary, addGlossaryTerm, deleteGlossaryTerm } from '../../services/glossaryService.js'
import { normalizeProjectStatus, isActiveProjectStatus } from '../../lib/projectStatus.js'
import { ScriptValidationError, SCRIPT_LIMITS, segmentContentHash } from '../../services/scriptService.js'
import {
  getScriptUploadForUser,
  reserveScriptUpload,
  releaseScriptUpload,
} from '../../services/scriptUploadService.js'
import { isPathInside } from '../../lib/safePath.js'

const router = Router()
router.use(authMiddleware)

// Test seam (post-commit side effects injectable — cùng pattern deps của
// cancelProjectUseCase). Production không đổi hành vi; test thay bằng fake.
export const createProjectPostDeps = { copyTranscript, runPipeline }

const MODES = ['SUMMARY', 'TRANSLATE_DUB', 'SCRIPT_TO_VIDEO']

// Canonical SCRIPT_TO_VIDEO mode; accept the product/legacy aliases at the API
// boundary but always persist the canonical value.
function normalizeMode(raw) {
  const m = String(raw || '').trim().toUpperCase().replace(/-/g, '_')
  if (m === 'AI_VIDEO' || m === 'SCRIPT_TO_VIDEO') return 'SCRIPT_TO_VIDEO'
  return m
}

const isScriptMode = (mode) => normalizeMode(mode) === 'SCRIPT_TO_VIDEO'

const VOICE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const SCRIPT_IMAGE_PROVIDERS = new Set(['slide', 'mock'])
const SCRIPT_ASPECTS = new Set(['16:9', '9:16'])

async function addScriptExtras(extras, project) {
  const analyze = await queryOne(
    `SELECT result FROM generation_jobs WHERE project_id = ? AND type = 'script.analyze' AND status = 'success'`,
    [project.id]
  )
  let analysis = null
  if (analyze?.result) {
    try {
      const parsed = JSON.parse(analyze.result)
      analysis = { source: parsed.source || null, warning: parsed.warning || null }
    } catch (_) {}
  }
  const segments = await query(
    `SELECT s.*, a.storage_key AS audio_key, ast.meta AS asset_meta
     FROM script_segments s
     LEFT JOIN audios a ON a.id = s.voice_audio_id
     LEFT JOIN assets ast ON ast.id = s.image_asset_id
     WHERE s.project_id = ? ORDER BY s.index_num ASC`,
    [project.id]
  )
  extras.scriptVersion = Number(project.script_version ?? 0)
  extras.scriptReviewRequired = Number(project.script_review_required || 0) === 1
  extras.scriptAnalysis = analysis
  extras.scriptSegments = segments.map((s) => ({
    id: s.id,
    orderIndex: s.index_num,
    narrationText: s.narration,
    visualPrompt: s.visual_prompt || '',
    status: s.status || 'pending',
    durationSec: s.duration_sec == null ? null : Number(s.duration_sec),
    hasAudio: Boolean(s.voice_audio_id && s.audio_key),
    hasImage: Boolean(s.image_asset_id && s.asset_meta),
    imageUrl: s.image_asset_id ? `/api/v1/projects/${project.id}/script/segments/${s.id}/image?v=${s.content_hash || ''}` : null,
    contentHash: s.content_hash || null,
  }))
}


const isDubMode = (mode) => {
  const m = String(mode || '').toUpperCase().replace('-', '_')
  return m === 'TRANSLATE_DUB'
}

// POST /api/v1/projects
router.post('/', async (req, res) => {
  let createdProjectId = null
  try {
    const b = req.body || {}
    // Chuẩn hoá mode về UPPERCASE, chấp nhận alias SCRIPT_TO_VIDEO từ client.
    const mode = normalizeMode(b.mode)
    if (!MODES.includes(mode)) {
      return sendError(res, 400, ERR.VALIDATION, 'mode must be SUMMARY, TRANSLATE_DUB or SCRIPT_TO_VIDEO', { field: 'mode' })
    }
    if (!b.title || !b.title.trim()) {
      return sendError(res, 400, ERR.VALIDATION, 'title is required', { field: 'title' })
    }
    if (b.title.trim().length > 200) {
      return sendError(res, 400, ERR.VALIDATION, 'title must be at most 200 characters', { field: 'title' })
    }
    if (mode !== 'SCRIPT_TO_VIDEO' && !b.sourceVideoKey) {
      return sendError(res, 400, ERR.VALIDATION, 'sourceVideoKey is required', { field: 'sourceVideoKey' })
    }

    // Group 1: Copyright validation
    if (b.copyrightAcknowledged !== true) {
      return sendError(res, 400, ERR.COPYRIGHT_MISSING,
        'Bạn phải xác nhận quyền sử dụng nội dung nguồn trước khi tạo project',
        { field: 'copyrightAcknowledged' })
    }

    let idempotencyKey = null
    const rawKey = req.headers['idempotency-key']
    if (rawKey !== undefined) {
      if (typeof rawKey !== 'string' || !rawKey.trim() || rawKey.length > 128) {
        return sendError(res, 400, ERR.VALIDATION, 'Idempotency-Key must be 1-128 characters', { field: 'Idempotency-Key' })
      }
      idempotencyKey = rawKey.trim()
    }

    const scriptMode = mode === 'SCRIPT_TO_VIDEO'
    let scriptUpload = null
    let scriptParams = null
    let idempotentProjectId = null
    if (scriptMode) {
      const uploadId = typeof b.scriptUploadId === 'string' ? b.scriptUploadId.trim() : ''
      if (!uploadId) {
        return sendError(res, 400, ERR.VALIDATION, 'scriptUploadId is required for SCRIPT_TO_VIDEO projects', { field: 'scriptUploadId' })
      }
      scriptUpload = await getScriptUploadForUser(uploadId, req.user.id)
      if (!scriptUpload) {
        // Hide existence from other users.
        return sendError(res, 404, 'SCRIPT_UPLOAD_NOT_FOUND', 'Không tìm thấy file kịch bản đã upload', { field: 'scriptUploadId' })
      }
      if (idempotencyKey) {
        const dup = await queryOne(
          'SELECT project_id FROM project_idempotency WHERE user_id = ? AND idem_key = ?',
          [req.user.id, idempotencyKey]
        )
        if (dup?.project_id) idempotentProjectId = dup.project_id
      }
      const uploadBoundToReplay = idempotentProjectId && scriptUpload.project_id === idempotentProjectId
      if (!uploadBoundToReplay && (scriptUpload.project_id || scriptUpload.status !== 'ready')) {
        return sendError(res, 409, 'SCRIPT_UPLOAD_ALREADY_USED', 'File kịch bản này đã được dùng cho một project khác', { field: 'scriptUploadId' })
      }
      const aspectRatio = b.aspectRatio || '16:9'
      if (!SCRIPT_ASPECTS.has(aspectRatio)) {
        return sendError(res, 400, ERR.VALIDATION, 'aspectRatio must be 16:9 or 9:16', { field: 'aspectRatio' })
      }
      const rawParams = b.params && typeof b.params === 'object' ? b.params : {}
      const voiceProvider = typeof rawParams.voiceProvider === 'string' && rawParams.voiceProvider.trim()
        ? rawParams.voiceProvider.trim()
        : 'edge_tts'
      if (!VOICE_ID_RE.test(voiceProvider)) {
        return sendError(res, 400, ERR.VALIDATION, 'voiceProvider is invalid', { field: 'voiceProvider' })
      }
      const voiceId = rawParams.voiceId == null || rawParams.voiceId === '' ? null : String(rawParams.voiceId)
      if (voiceId && !VOICE_ID_RE.test(voiceId)) {
        return sendError(res, 400, ERR.VALIDATION, 'voiceId must match [A-Za-z0-9._-]{1,64}', { field: 'voiceId' })
      }
      if (voiceId && voiceProvider === 'google_tts') {
        return sendError(res, 400, 'SCRIPT_VOICE_UNSUPPORTED', 'google_tts không hỗ trợ chọn voiceId — hãy chọn provider/voice khác', { field: 'voiceId' })
      }
      const imageProvider = typeof rawParams.imageProvider === 'string' && rawParams.imageProvider.trim()
        ? rawParams.imageProvider.trim()
        : 'slide'
      if (!SCRIPT_IMAGE_PROVIDERS.has(imageProvider)) {
        return sendError(res, 400, 'SCRIPT_IMAGE_PROVIDER_UNSUPPORTED', `imageProvider must be one of ${[...SCRIPT_IMAGE_PROVIDERS].join(', ')}`, { field: 'imageProvider' })
      }
      const burnSubtitles = rawParams.burnSubtitles === undefined ? true : Boolean(rawParams.burnSubtitles)
      scriptParams = {
        voiceProvider,
        voiceId,
        imageProvider,
        burnSubtitles,
        speed: 1,
      }
    }

    // Admission is performed atomically after request validation.

    // Merge params phẳng của TRANSLATE_DUB vào params JSON (docs/02 Project.params)
    let params = b.params && typeof b.params === 'object' ? { ...b.params } : {}
    if (mode === 'SCRIPT_TO_VIDEO') {
      params = scriptParams
    } else if (mode === 'TRANSLATE_DUB') {

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
      // Audio modes (TransFlow-inspired): DUB_MIX / DUB_REPLACE / ORIGINAL_ONLY.
      const rawMode = b.audioMode || params.audioMode
      params.audioMode = ['ORIGINAL_ONLY', 'DUB_MIX', 'DUB_REPLACE'].includes(rawMode)
        ? rawMode
        : (params.enableDubbing ? 'DUB_MIX' : 'ORIGINAL_ONLY')
      // Source separation (Demucs) DEFERRED — extension point only: stored but
      // not consumed by the pipeline yet (ducking full-mix thay thế).
      params.sourceSeparationEnabled = Boolean(b.sourceSeparationEnabled ?? params.sourceSeparationEnabled ?? false)
      if (params.sourceSeparationEnabled) {
        console.warn('[Projects] sourceSeparationEnabled=true chưa được hỗ trợ — pipeline hiện dùng ducking full-mix (xem mediaService AUDIO_MODES)')
      }
      if (params.enableDubbing && !b.voiceId && !params.voiceProvider && !params.voiceName) {
        // voice tuỳ chọn — chỉ cảnh báo qua log, không chặn tạo dự án
        console.warn('[Projects] TRANSLATE_DUB enableDubbing=true nhưng chưa chọn voice; dùng voice mặc định của provider')
      }
      params.voiceId = b.voiceId || params.voiceId || null

      params.outputFormat = ['mp4', 'mkv'].includes(b.outputFormat) ? b.outputFormat : 'mp4'
      params.translationVersion = TRANSLATION_VERSION
    }

    let admission
    let scriptProjectId = null
    let reservedScript = false
    try {
      scriptProjectId = idempotentProjectId
      if (scriptMode && !scriptProjectId) {
        scriptProjectId = uuidv4()
        reservedScript = await reserveScriptUpload(scriptUpload.id, req.user.id, scriptProjectId)
        if (!reservedScript) {
          return sendError(res, 409, 'SCRIPT_UPLOAD_ALREADY_USED', 'File kịch bản này đã được dùng cho một project khác', { field: 'scriptUploadId' })
        }
      }
      const admissionData = {
        id: scriptProjectId || uuidv4(),
        userId: req.user.id,
        mode,
        title: b.title.trim(),
        language: b.language || (mode === 'TRANSLATE_DUB' ? (params.targetLanguage || 'vi') : 'vi'),
        style: b.style || (mode === 'SUMMARY' ? 'cinematic' : (params.stylePreset || null)),
        targetDurationSec: Number(b.targetDurationSec) || (mode === 'SUMMARY' ? 1500 : 60),
        aspectRatio: b.aspectRatio || '16:9',
        params,
        sourceVideoKey: scriptMode ? null : (b.sourceVideoKey || null),
        videoHash: scriptMode ? null : (b.videoHash || null),
        copyrightAcknowledged: true,
        scriptUploadId: scriptMode ? scriptUpload.id : null,
        scriptKey: scriptMode ? scriptUpload.storage_key : null,
        scriptHash: scriptMode ? scriptUpload.sha256 : null,
        scriptVersion: 0,
        scriptReviewRequired: false,
      }
      const requestFingerprint = computeProjectFingerprint({
        mode: admissionData.mode,
        title: admissionData.title,
        language: admissionData.language,
        style: admissionData.style,
        targetDurationSec: admissionData.targetDurationSec,
        aspectRatio: admissionData.aspectRatio,
        params: admissionData.params,
        sourceVideoKey: admissionData.sourceVideoKey,
        videoHash: admissionData.videoHash,
        copyrightAcknowledged: true,
      })
      admission = await createProjectWithAdmission(admissionData, { idempotencyKey, requestFingerprint })
    } catch (admErr) {
      if (reservedScript) {
        try { await releaseScriptUpload(scriptUpload.id, req.user.id) } catch (_) {}
      }
      if (admErr?.code === 'IDEMPOTENCY_KEY_REUSE') {
        return sendError(res, 409, 'IDEMPOTENCY_KEY_REUSE', 'Idempotency key already used with a different request body', { projectId: admErr.projectId })
      }
      if (admErr?.code !== 'IDEMPOTENT_REPLAY') throw admErr
      const existing = admErr.projectId ? await queryOne('SELECT * FROM projects WHERE id = ?', [admErr.projectId]) : null
      if (!existing) throw admErr
      const publicExisting = { ...existing }
      delete publicExisting.script_key
      return res.status(202).json({ ...publicExisting, params, cachedProjectId: null, idempotentReplay: true })
    }
    const project = admission.project
    createdProjectId = project.id
    const status = project.status

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

    let transcriptCopyFailed = false
    const copySourceId = cachedProjectId || transcriptOnlySourceId
    if (copySourceId) {
      try {
        await createProjectPostDeps.copyTranscript(copySourceId, project.id, { includeTranslation: Boolean(cachedProjectId) })
      } catch (copyError) {
        // Project ĐÃ tồn tại (commit trước đó) — không 500 để client hiểu nhầm
        // "chưa tạo". Release admission → queued; drainQueued sẽ chạy lại
        // (re-transcribe nếu cache copy lỗi — degraded nhưng đúng).
        transcriptCopyFailed = true
        console.warn(`[Projects] copyTranscript thất bại cho ${project.id}:`, copyError?.message || copyError)
        try {
          await updateProjectOwned(project.id, admission.runToken, {
            status: 'queued', run_token: null, lease_expires_at: null,
            recovery_reason: 'cache copy failed; admission released',
          })
        } catch (releaseErr) {
          console.error(`[Projects] release admission thất bại cho ${project.id}:`, releaseErr?.message || releaseErr)
          throw releaseErr
        }
      }
    }

    // Kick off the real pipeline asynchronously — LUÔN CUỐI CÙNG, sau khi
    // copy cache xong (tránh race: stage skip-if-exists đọc nhầm bảng rỗng
    // hoặc ghi đè song song với copy). Bỏ qua khi copy lỗi (project đã về
    // queued, drainQueued nhận chạy lại khi có slot).
    if (status === 'pending' && !transcriptCopyFailed) {
      createProjectPostDeps.runPipeline(project.id, null, admission.runToken, { parkAfterAnalysis: scriptMode })
        .catch((e) => console.error('[Pipeline] start failed', e))
    }

    const publicProject = { ...project }
    delete publicProject.script_key
    if (transcriptCopyFailed) {
      const fresh = await queryOne('SELECT * FROM projects WHERE id = ?', [project.id])
      if (fresh) delete fresh.script_key
      return res.status(202).json({ ...(fresh || publicProject), params, cachedProjectId, transcriptCopyFailed: true })
    }
    res.status(202).json({ ...publicProject, params, cachedProjectId })
  } catch (err) {
    const extra = createdProjectId ? { projectId: createdProjectId } : {}
    if (err instanceof ScriptValidationError) {
      return sendError(res, err.statusCode, err.code, err.message, { ...err.extra, ...extra })
    }
    if (err?.code === 'DB_WRITE_QUEUE_FULL' || err?.code === 'DB_PERSISTENCE_BLOCKED') {
      return sendError(res, 503, err.code, 'Database write queue is busy', { retryAfterMs: err.retryAfterMs, ...extra })
    }
    console.error('Create project error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error', extra)
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
      params.push(normalizeMode(req.query.mode))
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
    const outputState = await getOutputState(project.id)
    const latestOutput = outputState.output
    // §1: pipeline đang chạy (pending/queued/running/generating) thì KHÔNG expose
    // output cũ — tránh user nhầm output của lần chạy trước là kết quả mới.
    // Không DELETE gì cả (non-destructive); row cũ vẫn nằm trong DB.
    // Read-path normalize: legacy 'success'→'completed', FE-only 'generating'→'running'.
    // One-off repair cho row lỡ persist 'generating': UPDATE projects SET status='running' WHERE status='generating'.
    const ACTIVE_OUTPUT_HIDDEN = new Set(['pending', 'queued', 'running', 'generating'])
    const normalizedStatus = normalizeProjectStatus(project.status)
    const output = project && (ACTIVE_OUTPUT_HIDDEN.has(project.status) || isActiveProjectStatus(normalizedStatus)) ? null : latestOutput
    let extras = {}
    if (project.mode === 'SUMMARY') {
      extras.scenes = await query('SELECT * FROM scenes WHERE project_id = ? ORDER BY start_sec ASC', [project.id])
      extras.scriptSegments = await query('SELECT * FROM script_segments WHERE project_id = ? ORDER BY index_num ASC', [project.id])
    } else if (isScriptMode(project.mode)) {
      await addScriptExtras(extras, project)
    } else if (isDubMode(project.mode)) {
      // TRANSLATE_DUB mode - no extra data needed
    }
    const publicProject = { ...project }
    delete publicProject.script_key
    res.json({ ...publicProject, params: project.params ? JSON.parse(project.params) : null, jobs, timeline, output, outputStale: outputState.outputStale, ...extras })
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
    const result = await updateSegmentTranslation(req.project.id, segmentId, translation, req.body?.revision)
    const outputState = await getOutputState(req.project.id)
    res.json({
      ...result.segment,
      revision: result.revision,
      outputStale: outputState.outputStale,
      warnings: gate.errors || [],
    })
  } catch (err) {
    if (err instanceof TranscriptRevisionConflict) {
      return sendError(res, 409, ERR.REVISION_CONFLICT, 'Transcript đã được cập nhật ở nơi khác — vui lòng tải lại trước khi lưu', {
        currentRevision: err.currentRevision,
        revision: err.currentRevision,
      })
    }
    if (err instanceof TranscriptValidationError) {
      return sendError(res, err.statusCode || 400, ERR.VALIDATION, err.message, { field: err.field })
    }
    if (err?.code === 'REVISION_REQUIRED') {
      return sendError(res, 400, ERR.VALIDATION, err.message, { field: 'revision' })
    }
    if (err?.code === 'DB_WRITE_QUEUE_FULL' || err?.code === 'DB_PERSISTENCE_BLOCKED') {
      return sendError(res, 503, err.code, 'Database write queue is busy', { retryAfterMs: err.retryAfterMs })
    }
    console.error('Update segment translation error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// PATCH /api/v1/projects/:id/script/segments/:segmentId — script review edit.
// Bumps script_version, invalidates dependent artifacts/jobs/output provenance.
router.patch('/:id/script/segments/:segmentId', requireProjectOwner, async (req, res) => {
  try {
    const project = req.project
    if (!isScriptMode(project.mode)) {
      return sendError(res, 400, ERR.VALIDATION, 'Not a SCRIPT_TO_VIDEO project', { field: 'mode' })
    }
    const b = req.body || {}
    const hasNarration = Object.prototype.hasOwnProperty.call(b, 'narrationText')
    const hasVisual = Object.prototype.hasOwnProperty.call(b, 'visualPrompt')
    if (!hasNarration && !hasVisual) {
      return sendError(res, 400, ERR.VALIDATION, 'Provide narrationText and/or visualPrompt', { field: 'narrationText' })
    }
    const narrationText = hasNarration ? String(b.narrationText ?? '').trim() : null
    const visualPrompt = hasVisual ? String(b.visualPrompt ?? '').trim() : null
    if (hasNarration && (!narrationText || [...narrationText].length > SCRIPT_LIMITS.maxSegmentChars)) {
      return sendError(res, 400, ERR.VALIDATION, `narrationText must be 1..${SCRIPT_LIMITS.maxSegmentChars} characters`, { field: 'narrationText' })
    }
    if (hasVisual && [...visualPrompt].length > SCRIPT_LIMITS.maxVisualChars) {
      return sendError(res, 400, ERR.VALIDATION, `visualPrompt must be at most ${SCRIPT_LIMITS.maxVisualChars} characters`, { field: 'visualPrompt' })
    }
    const scriptVersion = Number(b.scriptVersion)
    if (!Number.isInteger(scriptVersion) || scriptVersion < 0) {
      return sendError(res, 400, ERR.VALIDATION, 'scriptVersion is required', { field: 'scriptVersion' })
    }

    const outcome = await withTransaction(async (tx) => {
      const fresh = await tx.queryOne('SELECT * FROM projects WHERE id = ?', [project.id])
      if (!fresh) {
        const e = new Error('Project not found'); e.code = 'NOT_FOUND'; throw e
      }
      if (Number(fresh.script_version ?? 0) !== scriptVersion) {
        const e = new Error('Kịch bản đã thay đổi ở nơi khác — tải lại trước khi lưu')
        e.code = 'SCRIPT_VERSION_CONFLICT'
        e.currentVersion = Number(fresh.script_version ?? 0)
        throw e
      }
      if (fresh.status === 'pending' || fresh.status === 'running' || (fresh.status === 'queued' && Number(fresh.script_review_required || 0) === 0)) {
        const e = new Error('Pipeline đang chạy — không thể sửa kịch bản lúc này')
        e.code = 'PIPELINE_RUNNING'
        throw e
      }
      const seg = await tx.queryOne(
        'SELECT * FROM script_segments WHERE id = ? AND project_id = ?',
        [req.params.segmentId, project.id]
      )
      if (!seg) {
        const e = new Error('Segment not found in this project'); e.code = 'SEGMENT_NOT_FOUND'; throw e
      }
      const changedNarration = hasNarration && narrationText !== (seg.narration || '')
      const changedVisual = hasVisual && visualPrompt !== (seg.visual_prompt || '')
      if (!changedNarration && !changedVisual) {
        return { unchanged: true, segment: seg, scriptVersion }
      }

      const filesToDelete = []
      let voiceAudioId = seg.voice_audio_id || null
      let ttsClipKey = seg.tts_clip_key || null
      let durationSec = seg.duration_sec
      let imageAssetId = seg.image_asset_id || null

      if (changedNarration && seg.voice_audio_id) {
        const audio = await tx.queryOne('SELECT * FROM audios WHERE id = ? AND project_id = ?', [seg.voice_audio_id, project.id])
        if (audio?.storage_key) filesToDelete.push(audio.storage_key)
        await tx.run('DELETE FROM audios WHERE id = ? AND project_id = ?', [seg.voice_audio_id, project.id])
        voiceAudioId = null
        ttsClipKey = null
        durationSec = null
      }
      if (changedVisual && seg.image_asset_id) {
        const asset = await tx.queryOne('SELECT * FROM assets WHERE id = ? AND project_id = ?', [seg.image_asset_id, project.id])
        if (asset) {
          if (asset.storage_key) filesToDelete.push(asset.storage_key)
          try {
            const meta = JSON.parse(asset.meta || '{}')
            if (meta.previewKey) filesToDelete.push(meta.previewKey)
          } catch (_) {}
          await tx.run('DELETE FROM assets WHERE id = ? AND project_id = ?', [seg.image_asset_id, project.id])
        }
        imageAssetId = null
      }

      await tx.run('DELETE FROM timeline_clips WHERE project_id = ?', [project.id])
      await tx.run('DELETE FROM subtitles WHERE project_id = ?', [project.id])

      const resetStages = changedNarration
        ? ['script.tts', 'script.align', 'script.subtitle', 'script.render']
        : ['script.image', 'script.align', 'script.subtitle', 'script.render']
      const placeholders = resetStages.map(() => '?').join(',')
      await tx.run(
        `UPDATE generation_jobs SET status = 'pending', step = NULL, progress = 0,
         result = NULL, error_message = NULL, next_retry_at = NULL
         WHERE project_id = ? AND type IN (${placeholders})`,
        [project.id, ...resetStages]
      )

      const newNarration = hasNarration ? narrationText : (seg.narration || '')
      const newVisual = hasVisual ? visualPrompt : (seg.visual_prompt || '')
      const newStatus = changedNarration ? 'pending' : (voiceAudioId ? 'tts_ready' : 'pending')
      const nowIso = new Date().toISOString()
      await tx.run(
        `UPDATE script_segments SET narration = ?, visual_prompt = ?, content_hash = ?, updated_at = ?,
         voice_audio_id = ?, tts_clip_key = ?, duration_sec = ?, image_asset_id = ?, status = ?
         WHERE id = ? AND project_id = ?`,
        [newNarration, newVisual, segmentContentHash(newNarration, newVisual), nowIso,
          voiceAudioId, ttsClipKey, durationSec, imageAssetId, newStatus, seg.id, project.id]
      )
      await tx.run(
        'UPDATE projects SET script_version = COALESCE(script_version, 0) + 1, script_review_required = 1 WHERE id = ?',
        [project.id]
      )
      // A re-render invalidates queued publishes of older outputs; never touch
      // an upload already in flight (the video may already exist on YouTube).
      await tx.run(
        `UPDATE youtube_uploads SET status = 'cancelled', cancelled_at = ?, updated_at = ?
         WHERE status = 'queued' AND output_id IN (SELECT id FROM outputs WHERE project_id = ?)`,
        [nowIso, nowIso, project.id]
      )
      const updatedSeg = await tx.queryOne('SELECT * FROM script_segments WHERE id = ?', [seg.id])
      return { segment: updatedSeg, scriptVersion: Number(fresh.script_version ?? 0) + 1, filesToDelete, versionBumped: true }
    }, { op: 'script.segment.update' })

    for (const key of outcome.filesToDelete || []) {
      const abs = resolveStorageKey(key)
      if (abs && isPathInside(projectDir(project.id), abs)) {
        try { fs.unlinkSync(abs) } catch (_) {}
      }
    }
    if (outcome.versionBumped) {
      try { fs.unlinkSync(path.join(projectDir(project.id), 'subtitles.srt')) } catch (_) {}
      try { fs.unlinkSync(path.join(projectDir(project.id), 'subtitles.ass')) } catch (_) {}
    }
    const seg = outcome.segment
    res.json({
      scriptVersion: outcome.scriptVersion,
      segment: {
        id: seg.id,
        orderIndex: seg.index_num,
        narrationText: seg.narration,
        visualPrompt: seg.visual_prompt || '',
        status: seg.status || 'pending',
        durationSec: seg.duration_sec == null ? null : Number(seg.duration_sec),
        hasAudio: Boolean(seg.voice_audio_id),
        hasImage: Boolean(seg.image_asset_id),
        imageUrl: seg.image_asset_id ? `/api/v1/projects/${project.id}/script/segments/${seg.id}/image?v=${seg.content_hash || ''}` : null,
        contentHash: seg.content_hash || null,
      },
    })
  } catch (err) {
    if (err?.code === 'SCRIPT_VERSION_CONFLICT') {
      return sendError(res, 409, 'SCRIPT_VERSION_CONFLICT', err.message, { currentVersion: err.currentVersion })
    }
    if (err?.code === 'PIPELINE_RUNNING') return sendError(res, 409, 'PIPELINE_RUNNING', err.message)
    if (err?.code === 'SEGMENT_NOT_FOUND') return sendError(res, 404, 'SEGMENT_NOT_FOUND', err.message)
    if (err?.code === 'NOT_FOUND') return sendError(res, 404, ERR.PROJECT_NOT_FOUND, err.message)
    if (err?.code === 'DB_WRITE_QUEUE_FULL' || err?.code === 'DB_PERSISTENCE_BLOCKED') {
      return sendError(res, 503, err.code, 'Database write queue is busy', { retryAfterMs: err.retryAfterMs })
    }
    console.error('Update script segment error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// GET /api/v1/projects/:id/script/segments/:segmentId/image?size=preview|full
// Private script image; owner-checked, never served through /storage.
router.get('/:id/script/segments/:segmentId/image', requireProjectOwner, async (req, res) => {
  try {
    const project = req.project
    const seg = await queryOne(
      'SELECT * FROM script_segments WHERE id = ? AND project_id = ?',
      [req.params.segmentId, project.id]
    )
    if (!seg || !seg.image_asset_id) return sendError(res, 404, 'SCRIPT_IMAGE_NOT_FOUND', 'Đoạn kịch bản chưa có ảnh')
    const asset = await queryOne('SELECT * FROM assets WHERE id = ? AND project_id = ?', [seg.image_asset_id, project.id])
    if (!asset) return sendError(res, 404, 'SCRIPT_IMAGE_NOT_FOUND', 'Đoạn kịch bản chưa có ảnh')
    let meta = {}
    try { meta = JSON.parse(asset.meta || '{}') } catch (_) {}
    const size = req.query.size === 'full' ? 'full' : 'preview'
    const key = size === 'preview' && meta.previewKey ? meta.previewKey : asset.storage_key
    const abs = resolveStorageKey(key)
    if (!abs || !isPathInside(projectDir(project.id), abs) || !fs.existsSync(abs)) {
      return sendError(res, 404, 'SCRIPT_IMAGE_NOT_FOUND', 'Tệp ảnh không tồn tại')
    }
    res.setHeader('Content-Type', 'image/bmp')
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.sendFile(abs)
  } catch (err) {
    console.error('Script segment image error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})


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
  const validStages = stagesForProject(project)
  const requestedStage = req.body?.fromStage
  if (requestedStage && !validStages.includes(requestedStage)) {
    return sendError(res, 400, ERR.VALIDATION, `Giai đoạn yêu cầu không hợp lệ: ${requestedStage}. Các giai đoạn hợp lệ: ${validStages.join(', ')}`)
  }

  const jobs = await query(
    `SELECT type, status, next_retry_at FROM generation_jobs WHERE project_id = ?`,
    [project.id]
  )
  const r = firstRunnableStage(validStages, jobs)
  // Queued/pending = waiting for a slot (or review). "Chạy lại" resumes the
  // earliest incomplete stage, never restarts a finished generation.
  const resumingQueued = !requestedStage && ['queued', 'pending'].includes(project.status)

  if (resumingQueued && Number(project.script_review_required || 0) === 1) {
    return sendError(res, 409, 'SCRIPT_REVIEW_REQUIRED',
      'Dự án đang chờ duyệt kịch bản — hãy duyệt kịch bản rồi dùng "Tạo video" thay vì "Chạy lại".',
      { field: 'script_review_required' })
  }
  if (!requestedStage && r.waiting) {
    return sendError(res, 429, 'RETRY_WAITING', `Stage ${r.type} đang chờ quota hồi phục, thử lại sau ${new Date(r.nextRetryAt).toLocaleTimeString('vi-VN')}`, {
      stage: r.type,
      nextRetryAt: r.nextRetryAt,
    })
  }
  if (resumingQueued && !r.type) {
    return sendError(res, 409, 'ALREADY_COMPLETED',
      'Tất cả các bước đã hoàn tất — không còn bước nào để tiếp tục.')
  }
  if (isPipelineRunning(project.id)) {
    return sendError(res, 409, 'PIPELINE_RUNNING', 'Pipeline đang chạy, hãy đợi hoàn tất rồi mới chạy lại')
  }
  const admission = await acquireProjectRun(project.id, { allowReserved: true, reclaimExpiredRunning: true })
  if (!admission.admitted) {
    const status = admission.reason === 'concurrency' ? 429 : 409
    const message = admission.reason === 'concurrency'
      ? (resumingQueued
        ? 'Đã đạt giới hạn dự án chạy song song — dự án vẫn ở trạng thái Đang chờ và sẽ tự chạy khi có slot trống.'
        : 'Đã đạt giới hạn dự án chạy song song, thử lại sau.')
      : 'Pipeline đang bận, thử lại sau.'
    return sendError(res, status, status === 429 ? ERR.CONCURRENCY_LIMIT : 'PIPELINE_BUSY', message, { retryable: status === 429 })
  }
  const targetStage = requestedStage || r.type
  const scriptMode = isScriptMode(project.mode)
  if (scriptMode) {
    await run(
      'UPDATE projects SET script_review_required = 0 WHERE id = ?',
      [project.id],
      { op: 'script.review.clear' }
    )
  }
  const parkAfterAnalysis = scriptMode && (
    targetStage === null || targetStage === 'script.ingest' || targetStage === 'script.analyze'
  )
  runPipeline(project.id, targetStage, admission.runToken, {
    forceTranscript: targetStage === null || ['dub.ingest', 'dub.stt'].includes(targetStage),
    parkAfterAnalysis,
  }).catch(() => {})
  res.json({ message: 'Pipeline restarted', status: admission.project.status, ...(targetStage ? { fromStage: targetStage } : {}) })
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
    // The whole DB wipe commits as ONE transaction: a mid-wipe failure can no
    // longer leave a partially deleted project on disk, and a retry after a
    // rejected DELETE starts from a complete state (no duplicate/partial work).
    let cleanupTaskId = null
    // Deterministic idempotency key for the cleanup outbox (derived from the
    // route param only — never from arbitrary client input).
    const operation = 'PROJECT_DELETE'
    const operation_key = `project-delete:${req.params.id}`
    await withTransaction(async (tx) => {
      // ProviderLog is independent of the project lifecycle (docs/02 §5):
      // keep the rows for analytics, only detach them from the deleted project.
      await tx.run('UPDATE provider_logs SET project_id = NULL WHERE project_id = ?', [req.params.id])
      await tx.run(`DELETE FROM youtube_uploads WHERE project_id = ? OR output_id IN (SELECT id FROM outputs WHERE project_id = ?)`, [req.params.id, req.params.id])
      await tx.run('DELETE FROM script_uploads WHERE project_id = ?', [req.params.id])
      // Same rows deleteProjectTranscript() would remove — inlined because a
      // nested withTransaction would deadlock on the single-writer queue.
      await tx.runAffected('DELETE FROM transcript_segments WHERE project_id = ?', [req.params.id])
      for (const t of ['generation_jobs', 'assets', 'scenes', 'script_segments', 'ocr_regions', 'timeline_clips', 'audios', 'subtitles', 'outputs', 'project_glossaries']) {
        await tx.run(`DELETE FROM ${t} WHERE project_id = ?`, [req.params.id])
      }
      await tx.run('DELETE FROM project_idempotency WHERE project_id = ?', [req.params.id])
      await tx.run('DELETE FROM projects WHERE id = ?', [req.params.id])
      // Outbox: cleanup task commit nguyên tử với DB wipe — fs fail không mất task.
      // Chỉ tạo task khi còn file cần dọn: project không file thì không thêm
      // write/save thừa (giữ postCommitBoundaries `saveCalls === 1`).
      if (fileKeys.size > 0) {
        const nowIso = new Date().toISOString()
        const candidateId = uuidv4()
        const claimed = await tx.runAffected(
          `INSERT OR IGNORE INTO project_cleanup_tasks (id, project_id, keys_json, status, attempts, next_attempt_at, operation, operation_key)
           VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
          [candidateId, req.params.id, JSON.stringify([...fileKeys]), nowIso, operation, operation_key]
        )
        if (claimed === 1) {
          cleanupTaskId = candidateId
        } else {
          const existing = await tx.queryOne(
            `SELECT id FROM project_cleanup_tasks WHERE operation_key = ? AND status = 'pending'`,
            [operation_key]
          )
          cleanupTaskId = existing ? existing.id : null
        }
      }
    }, { op: 'project.delete' })
    // Post-commit fast path: thử dọn ngay qua runCleanupTask (bên trong gọi
    // deleteProjectFiles(project, keys)); thất bại thì task pending sẽ được
    // sweep retry (server.js interval 60s) — không bao giờ mất, không rollback DB.
    if (cleanupTaskId) {
      try {
        const outcome = await runCleanupTask({ id: cleanupTaskId, project_id: req.params.id, keys_json: JSON.stringify([...fileKeys]), attempts: 0, operation, operation_key })
        if (outcome.status !== 'done') {
          console.warn(`[Projects] xoá ${req.params.id}: cleanup chưa hoàn tất (${outcome.status}) — sẽ retry`)
        }
      } catch (cleanupErr) {
        console.error(`[Projects] cleanup ${req.params.id} post-commit lỗi (sẽ retry):`, cleanupErr?.message || cleanupErr)
      }
    }
    res.json({ message: 'Deleted' })
  } catch (err) {
    console.error('Delete project error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// GET /api/v1/projects/:id/glossary — minimal per-project terminology.
// Rendered into the LLM prompt as <glossary><term .../></glossary>.
router.get('/:id/glossary', requireProjectOwner, async (req, res) => {
  try {
    res.json(await listGlossary(req.project.id))
  } catch (err) {
    console.error('List glossary error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// POST /api/v1/projects/:id/glossary {source, target, caseSensitive?, note?}
router.post('/:id/glossary', requireProjectOwner, async (req, res) => {
  try {
    const term = await addGlossaryTerm(req.project.id, {
      source: req.body?.source ?? req.body?.sourceTerm,
      target: req.body?.target ?? req.body?.targetTerm,
      caseSensitive: req.body?.caseSensitive ?? req.body?.case_sensitive ?? false,
      note: req.body?.note ?? null,
    })
    res.status(201).json(term)
  } catch (err) {
    if (err?.statusCode === 400) return sendError(res, 400, ERR.VALIDATION, err.message, { field: 'source' })
    console.error('Add glossary error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// DELETE /api/v1/projects/:id/glossary/:termId
router.delete('/:id/glossary/:termId', requireProjectOwner, async (req, res) => {
  try {
    const ok = await deleteGlossaryTerm(req.project.id, req.params.termId)
    if (!ok) return sendError(res, 404, ERR.VALIDATION, 'Glossary term not found', { field: 'termId' })
    res.json({ message: 'Deleted' })
  } catch (err) {
    console.error('Delete glossary error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

export default router
