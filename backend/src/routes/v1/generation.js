import { Router } from 'express'
import { query, queryOne } from '../../db/query.js'
import { authMiddleware } from '../../middleware/auth.js'
import { requireProjectOwner } from '../../middleware/projectAccess.js'
import { runPipeline, STAGES } from '../../pipeline/runner.js'

const router = Router()
router.use(authMiddleware)

// POST /api/v1/projects/:id/summary/start
router.post('/:id/summary/start', requireProjectOwner, async (req, res) => {
  if (req.project.mode !== 'SUMMARY') return res.status(400).json({ message: 'Not a SUMMARY project', code: 'VALIDATION_ERROR' })
  runPipeline(req.project.id).catch(() => {})
  res.json({ message: 'Started', status: 'running' })
})

// POST /api/v1/projects/:id/style-edit/start
router.post('/:id/style-edit/start', requireProjectOwner, async (req, res) => {
  if (req.project.mode !== 'STYLE_EDIT') return res.status(400).json({ message: 'Not a STYLE_EDIT project', code: 'VALIDATION_ERROR' })
  runPipeline(req.project.id).catch(() => {})
  res.json({ message: 'Started', status: 'running' })
})

// GET /api/v1/projects/:id/jobs
router.get('/:id/jobs', requireProjectOwner, async (req, res) => {
  const jobs = await query(
    `SELECT j.*, pl.provider AS provider, pl.duration_ms AS duration_ms,
            COALESCE(pl.cost_usd, 0) AS cost_estimate
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
  const stages = STAGES[req.project.mode] || []
  if (!stages.includes(type)) {
    return res.status(400).json({ message: `Unknown stage '${type}' for mode ${req.project.mode}`, code: 'VALIDATION_ERROR' })
  }
  const job = await queryOne('SELECT * FROM generation_jobs WHERE project_id = ? AND type = ?', [req.project.id, type])
  if (!job) return res.status(404).json({ message: 'Job not found', code: 'NOT_FOUND' })
  if (!['failed', 'error', 'timeout'].includes(job.status)) {
    return res.status(409).json({ message: `Job is ${job.status}; only failed jobs can be retried`, code: 'JOB_001' })
  }
  runPipeline(req.project.id, type).catch(() => {})
  res.json({ message: 'Retrying', status: 'running' })
})

export default router
