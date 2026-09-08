import { queryOne, insert } from '../db/query.js'
import { v4 as uuidv4 } from 'uuid'
import { config } from '../config.js'
import { runPipeline } from '../pipeline/runner.js'

/**
 * CreateProjectUseCase — copyright validation + concurrency limit
 * Validates copyrightAcknowledged, checks MAX_CONCURRENT_PROJECTS_PER_USER,
 * creates project with status PENDING or QUEUED.
 */
export async function createProjectUseCase(userId, data) {
  // 1. Validate copyrightAcknowledged
  if (data.copyrightAcknowledged !== true) {
    const err = new Error('Bạn phải xác nhận quyền sử dụng nội dung nguồn trước khi tạo project')
    err.code = 'COPYRIGHT_001'
    throw err
  }

  // 2. Count running projects for this user
  const running = await queryOne(
    `SELECT COUNT(*) as cnt FROM projects WHERE user_id = ? AND status = 'running'`,
    [userId]
  )
  const runningCount = running?.cnt || 0
  const maxConcurrent = config.maxConcurrentProjectsPerUser

  // 3. Determine initial status
  let status = 'pending'
  if (runningCount >= maxConcurrent) {
    status = 'queued'
  }

  // 4. Calculate expires_at based on retention policy
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + config.projectRetentionDays)

  // 5. Create project
  const projectId = uuidv4()
  const now = new Date().toISOString()

  const project = await insert('projects', {
    id: projectId,
    user_id: userId,
    mode: data.mode,
    title: data.title,
    status,
    language: data.language || 'vi',
    style: data.style || null,
    target_duration_sec: data.targetDurationSec || 60,
    aspect_ratio: data.aspectRatio || '16:9',
    params: JSON.stringify(data.params || {}),
    source_video_key: data.sourceVideoKey || null,
    copyright_acknowledged: 1,
    copyright_ack_at: now,
    expires_at: expiresAt.toISOString(),
  })

  // 6. If status is pending, enqueue pipeline
  if (status === 'pending') {
    runPipeline(projectId).catch((e) => console.error('[Pipeline] start failed', e))
  }

  return project
}

export default createProjectUseCase
