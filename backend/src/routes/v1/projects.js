import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, insert, updateById, run } from '../../db/query.js'
import { authMiddleware, requireRole } from '../../middleware/auth.js'
import { requireProjectOwner } from '../../middleware/projectAccess.js'
import { runPipeline, isPipelineRunning } from '../../pipeline/runner.js'
import { deleteProjectFiles, collectProjectKeys } from '../../services/projectCleanup.js'
import { sendError, ERR } from '../../lib/httpError.js'

const router = Router()
router.use(authMiddleware)

const MODES = ['SUMMARY', 'TRANSLATE_DUB']
const MASK_METHODS = ['blur', 'fill', 'inpaint']

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

    // Merge params phẳng của TRANSLATE_DUB vào params JSON (docs/02 Project.params)
    let params = b.params && typeof b.params === 'object' ? { ...b.params } : {}
    if (mode === 'TRANSLATE_DUB') {
      const maskMethod = b.maskMethod || params.maskMethod || 'fill'
      if (!MASK_METHODS.includes(maskMethod)) {
        return sendError(res, 400, ERR.VALIDATION, `maskMethod must be one of ${MASK_METHODS.join(', ')}`, { field: 'maskMethod' })
      }
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
      if (params.enableDubbing && !b.voiceId && !params.voiceProvider && !params.voiceName) {
        // voice tuỳ chọn — chỉ cảnh báo qua log, không chặn tạo dự án
        console.warn('[Projects] TRANSLATE_DUB enableDubbing=true nhưng chưa chọn voice; dùng voice mặc định của provider')
      }
      params.voiceId = b.voiceId || params.voiceId || null
      params.maskMethod = maskMethod
      params.outputFormat = ['mp4', 'mkv'].includes(b.outputFormat) ? b.outputFormat : 'mp4'
    }

    const project = await insert('projects', {
      id: uuidv4(),
      user_id: req.user.id,
      mode,
      title: b.title.trim(),
      status: 'pending',
      language: b.language || (mode === 'TRANSLATE_DUB' ? (params.targetLanguage || 'vi') : 'vi'),
      style: b.style || (mode === 'SUMMARY' ? 'cinematic' : (params.stylePreset || null)),
      target_duration_sec: Number(b.targetDurationSec) || (mode === 'SUMMARY' ? 1500 : 60),
      aspect_ratio: b.aspectRatio || '16:9',
      params: JSON.stringify(params),
      source_video_key: b.sourceVideoKey || null,
      template_video_key: null, // legacy STYLE_EDIT — ngừng ghi (docs/00 §2.2)
    })

    // Kick off the real pipeline asynchronously
    runPipeline(project.id).catch((e) => console.error('[Pipeline] start failed', e))

    res.status(202).json({ ...project, params })
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
      // docs/06 §7: TRANSLATE_DUB trả thêm ocrRegions (transcript qua endpoint riêng)
      extras.ocrRegions = await query('SELECT * FROM ocr_regions WHERE project_id = ? ORDER BY start_sec ASC', [project.id])
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

// POST /api/v1/projects/:id/regenerate — rerun pipeline from the first failed
// job (or from scratch when everything succeeded). Idempotent: the pipeline
// clears derived rows before rewriting them.
router.post('/:id/regenerate', requireProjectOwner, async (req, res) => {
  const project = req.project
  const failed = await queryOne(
    `SELECT type FROM generation_jobs
     WHERE project_id = ? AND status IN ('failed','error','timeout')
     ORDER BY created_date ASC LIMIT 1`,
    [project.id]
  )
  runPipeline(project.id, failed ? failed.type : null).catch(() => {})
  res.json({ message: 'Pipeline restarted', status: 'running' })
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
