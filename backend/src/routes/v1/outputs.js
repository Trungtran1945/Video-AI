import { Router } from 'express'
import { query, queryOne } from '../../db/query.js'
import { authMiddleware } from '../../middleware/auth.js'
import { requireOutputOwner } from '../../middleware/projectAccess.js'
import { sendError, ERR } from '../../lib/httpError.js'
import { outputIsStale } from '../../services/outputService.js'
import {
  YoutubePublishError,
  startPublish,
  getPublishStatus,
  cancelPublish,
} from '../../services/youtubePublishService.js'

const router = Router()
router.use(authMiddleware)

function staleFor(row) {
  const mode = String(row.mode || '').toUpperCase().replace('-', '_')
  const version = mode === 'SCRIPT_TO_VIDEO' ? row.project_script_version : row.project_transcript_version
  return outputIsStale(row.mode, version, row)
}

const OUTPUT_SELECT = `SELECT o.*, p.user_id, p.title as project_title, p.mode,
                      p.transcript_version AS project_transcript_version,
                      p.script_version AS project_script_version
               FROM outputs o JOIN projects p ON o.project_id = p.id`

function sendPublishError(res, err) {
  if (err instanceof YoutubePublishError) {
    return sendError(res, err.statusCode, err.code, err.message)
  }
  console.error('YouTube publish error:', err?.message || err)
  return sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
}

async function attachYoutubeUploads(outputRows) {
  if (!outputRows.length) return []
  const outputIds = outputRows.map((r) => r.id)
  const placeholders = outputIds.map(() => '?').join(',')
  const ytRows = await query(
    `SELECT id, output_id, status, privacy, progress, youtube_video_id, youtube_url, error_message, updated_at, created_date
     FROM youtube_uploads
     WHERE output_id IN (${placeholders})
     ORDER BY created_date DESC, rowid DESC`,
    outputIds
  )
  const ytByOutput = new Map()
  for (const yt of ytRows) {
    if (!ytByOutput.has(yt.output_id)) {
      const videoUrl = yt.youtube_url || (yt.youtube_video_id ? `https://youtu.be/${yt.youtube_video_id}` : null)
      ytByOutput.set(yt.output_id, {
        id: yt.id,
        status: yt.status,
        privacy: yt.privacy,
        progress: yt.progress != null ? Number(yt.progress) : null,
        youtubeVideoId: yt.youtube_video_id || null,
        youtubeVideoUrl: videoUrl,
        youtubeUrl: videoUrl,
        errorMessage: yt.error_message || null,
        updatedAt: yt.updated_at,
        createdDate: yt.created_date,
      })
    }
  }
  return outputRows.map((r) => ({
    ...r,
    outputStale: staleFor(r),
    url: r.storage_key ? `/storage/${r.storage_key}` : null,
    youtubeUpload: ytByOutput.get(r.id) || null,
  }))
}

// GET /api/v1/outputs?projectId=
router.get('/', async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin'
    let sql = OUTPUT_SELECT
    const params = []
    if (!isAdmin) { sql += ' WHERE p.user_id = ?'; params.push(req.user.id) }
    if (req.query.projectId) { sql += (params.length ? ' AND' : ' WHERE') + ' o.project_id = ?'; params.push(req.query.projectId) }
    sql += ' ORDER BY o.created_date DESC'
    const rows = await query(sql, params)
    const enriched = await attachYoutubeUploads(rows)
    res.json(enriched)
  } catch (err) {
    console.error('List outputs error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// GET /api/v1/outputs/:id
router.get('/:id', async (req, res) => {
  const o = await queryOne(`${OUTPUT_SELECT} WHERE o.id = ?`, [req.params.id])
  if (!o) return sendError(res, 404, 'NOT_FOUND', 'Output not found')
  if (o.user_id !== req.user.id && req.user.role !== 'admin') return sendError(res, 403, ERR.AUTH_FORBIDDEN, 'Forbidden')
  const [enriched] = await attachYoutubeUploads([o])
  res.json(enriched)
})

// POST /api/v1/outputs/:id/youtube — 202 outbox row, worker does the upload.
router.post('/:id/youtube', requireOutputOwner, async (req, res) => {
  try {
    const result = await startPublish({ outputId: req.output.id, payload: req.body })
    res.status(202).json(result)
  } catch (err) {
    sendPublishError(res, err)
  }
})

// GET /api/v1/outputs/:id/youtube
router.get('/:id/youtube', requireOutputOwner, async (req, res) => {
  try {
    res.json(await getPublishStatus(req.output.id))
  } catch (err) {
    sendPublishError(res, err)
  }
})

// POST /api/v1/outputs/:id/youtube/cancel
router.post('/:id/youtube/cancel', requireOutputOwner, async (req, res) => {
  try {
    res.json(await cancelPublish({ outputId: req.output.id }))
  } catch (err) {
    sendPublishError(res, err)
  }
})

export default router
