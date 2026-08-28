import { Router } from 'express'
import { query, queryOne } from '../../db/query.js'
import { authMiddleware } from '../../middleware/auth.js'
import { requireProjectOwner } from '../../middleware/projectAccess.js'
import { runPipeline, flatStages, isPipelineRunning } from '../../pipeline/runner.js'
import { sendError, ERR } from '../../lib/httpError.js'

const router = Router()
router.use(authMiddleware)

// POST /api/v1/projects/:id/summary/start
router.post('/:id/summary/start', requireProjectOwner, async (req, res) => {
  if (req.project.mode !== 'SUMMARY') return sendError(res, 400, ERR.VALIDATION, 'Not a SUMMARY project', { field: 'mode' })
  runPipeline(req.project.id).catch(() => {})
  res.json({ message: 'Started', status: 'running' })
})

// POST /api/v1/projects/:id/translate-dub/start (docs/06 §3)
router.post('/:id/translate-dub/start', requireProjectOwner, async (req, res) => {
  if (String(req.project.mode).toUpperCase().replace('-', '_') !== 'TRANSLATE_DUB') {
    return sendError(res, 400, ERR.VALIDATION, 'Not a TRANSLATE_DUB project', { field: 'mode' })
  }
  runPipeline(req.project.id).catch(() => {})
  res.json({ message: 'Started', status: 'running' })
})

// POST /api/v1/projects/:id/translate-dub/redub
// Chạy lại chỉ phần lồng tiếng + render (dub.ttsAlign → dub.render) dùng bản dịch
// ĐÃ CHỈNH SỬA trong transcript_segments. Không dịch lại, không mất chỉnh sửa.
router.post('/:id/translate-dub/redub', requireProjectOwner, async (req, res) => {
  if (String(req.project.mode).toUpperCase().replace('-', '_') !== 'TRANSLATE_DUB') {
    return sendError(res, 400, ERR.VALIDATION, 'Not a TRANSLATE_DUB project', { field: 'mode' })
  }
  if (isPipelineRunning(req.project.id)) {
    return sendError(res, 409, 'PIPELINE_RUNNING', 'Pipeline đang chạy, hãy đợi hoàn tất rồi mới chạy lại')
  }
  runPipeline(req.project.id, 'dub.ttsAlign').catch(() => {})
  res.json({ message: 'Re-dub started', status: 'running' })
})

// GET /api/v1/projects/:id/jobs
router.get('/:id/jobs', requireProjectOwner, async (req, res) => {
  const jobs = await query(
    `SELECT j.*, pl.provider AS provider,
            pl.duration_ms AS duration_ms
     FROM generation_jobs j
     LEFT JOIN provider_logs pl ON pl.job_id = j.id AND pl.status = 'ok'
     WHERE j.project_id = ?
     ORDER BY j.created_date ASC`,
    [req.params.id]
  )
  res.json(jobs)
})

// POST /api/v1/projects/:id/jobs/:type/retry — only failed jobs of this project
router.post('/:id/jobs/:type/retry', requireProjectOwner, async (req, res) => {
  const { type } = req.params
  const stages = flatStages(String(req.project.mode).toUpperCase().replace('-', '_'))
  if (!stages.includes(type)) {
    return sendError(res, 400, ERR.VALIDATION, `Unknown stage '${type}' for mode ${req.project.mode}`, { field: 'type' })
  }
  const job = await queryOne('SELECT * FROM generation_jobs WHERE project_id = ? AND type = ?', [req.project.id, type])
  if (!job) return sendError(res, 404, 'NOT_FOUND', 'Job not found')
  if (!['failed', 'error', 'timeout'].includes(job.status)) {
    return sendError(res, 409, ERR.JOB_NOT_RETRYABLE, `Job is ${job.status}; only failed jobs can be retried`)
  }
  runPipeline(req.project.id, type).catch(() => {})
  res.json({ message: 'Retrying', status: 'running' })
})

export default router
