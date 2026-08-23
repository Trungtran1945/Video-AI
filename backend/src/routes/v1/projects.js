import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, insert, updateById, run } from '../../db/query.js'
import { authMiddleware, requireRole } from '../../middleware/auth.js'
import { requireProjectOwner } from '../../middleware/projectAccess.js'
import { runPipeline, isPipelineRunning } from '../../pipeline/runner.js'
import { deleteProjectFiles, collectProjectKeys } from '../../services/projectCleanup.js'

const router = Router()
router.use(authMiddleware)

const MODES = ['SUMMARY', 'STYLE_EDIT']

// POST /api/v1/projects
router.post('/', async (req, res) => {
  try {
    const b = req.body || {}
    if (!MODES.includes(b.mode)) {
      return res.status(400).json({ message: 'mode must be SUMMARY or STYLE_EDIT', code: 'VALIDATION_ERROR' })
    }
    if (!b.title || !b.title.trim()) {
      return res.status(400).json({ message: 'title is required', code: 'VALIDATION_ERROR' })
    }
    const project = await insert('projects', {
      id: uuidv4(),
      user_id: req.user.id,
      mode: b.mode,
      title: b.title.trim(),
      status: 'pending',
      language: b.language || 'vi',
      style: b.style || 'cinematic',
      target_duration_sec: Number(b.targetDurationSec) || (b.mode === 'SUMMARY' ? 1500 : 45),
      aspect_ratio: b.aspectRatio || (b.mode === 'SUMMARY' ? '16:9' : '9:16'),
      params: b.params ? JSON.stringify(b.params) : null,
      source_video_key: b.sourceVideoKey || null,
      template_video_key: b.templateVideoKey || null,
    })

    if (Array.isArray(b.assets)) {
      for (const a of b.assets) {
        if (a && a.storageKey) {
          await insert('assets', {
            id: uuidv4(),
            project_id: project.id,
            kind: a.kind || 'unknown',
            storage_key: a.storageKey,
            meta: a.meta ? JSON.stringify(a.meta) : null,
            duration_sec: a.durationSec || null,
          })
        }
      }
    }

    // Kick off the real pipeline asynchronously
    runPipeline(project.id).catch((e) => console.error('[Pipeline] start failed', e))

    res.status(202).json({ ...project, params: b.params || null })
  } catch (err) {
    console.error('Create project error:', err)
    res.status(500).json({ message: 'Internal server error', code: 'INTERNAL_ERROR' })
  }
})

// GET /api/v1/projects
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
      params.push(req.query.mode)
    }
    sql += ' ORDER BY created_date DESC'
    const rows = await query(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('List projects error:', err)
    res.status(500).json({ message: 'Internal server error', code: 'INTERNAL_ERROR' })
  }
})

// GET /api/v1/projects/:id (with jobs, timeline, output, extras)
router.get('/:id', async (req, res) => {
  try {
    const project = await queryOne('SELECT * FROM projects WHERE id = ?', [req.params.id])
    if (!project) return res.status(404).json({ message: 'Project not found', code: 'NOT_FOUND' })
    if (project.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden', code: 'FORBIDDEN' })
    }
    const jobs = await query('SELECT * FROM generation_jobs WHERE project_id = ? ORDER BY created_date ASC', [project.id])
    const timeline = await query('SELECT * FROM timeline_clips WHERE project_id = ? ORDER BY order_index ASC', [project.id])
    const output = await queryOne('SELECT * FROM outputs WHERE project_id = ? ORDER BY created_date DESC LIMIT 1', [project.id])
    let extras = {}
    if (project.mode === 'SUMMARY') {
      extras.scenes = await query('SELECT * FROM scenes WHERE project_id = ? ORDER BY start_sec ASC', [project.id])
      extras.scriptSegments = await query('SELECT * FROM script_segments WHERE project_id = ? ORDER BY index_num ASC', [project.id])
    } else {
      extras.assets = await query('SELECT * FROM assets WHERE project_id = ?', [project.id])
    }
    res.json({ ...project, params: project.params ? JSON.parse(project.params) : null, jobs, timeline, output, ...extras })
  } catch (err) {
    console.error('Get project error:', err)
    res.status(500).json({ message: 'Internal server error', code: 'INTERNAL_ERROR' })
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
    if (!project) return res.status(404).json({ message: 'Project not found', code: 'NOT_FOUND' })
    if (project.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden', code: 'FORBIDDEN' })
    }
    // Deleting mid-run would leave the pipeline writing into removed folders/rows.
    if (isPipelineRunning(project.id)) {
      return res.status(409).json({
        message: 'Pipeline đang chạy, hãy đợi hoàn tất hoặc thất bại rồi mới xoá được dự án',
        code: 'PIPELINE_RUNNING',
      })
    }
    // Collect file references BEFORE wiping rows — afterwards the queries
    // would find nothing and uploads/outputs files would be orphaned.
    const fileKeys = await collectProjectKeys(project)
    // ProviderLog is independent of the project lifecycle (docs/02 §5):
    // keep the rows for analytics, only detach them from the deleted project.
    await run('UPDATE provider_logs SET project_id = NULL WHERE project_id = ?', [req.params.id])
    await run(`DELETE FROM youtube_uploads WHERE output_id IN (SELECT id FROM outputs WHERE project_id = ?)`, [req.params.id])
    for (const t of ['generation_jobs', 'assets', 'scenes', 'script_segments', 'timeline_clips', 'audios', 'subtitles', 'outputs']) {
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
    res.status(500).json({ message: 'Internal server error', code: 'INTERNAL_ERROR' })
  }
})

export default router
