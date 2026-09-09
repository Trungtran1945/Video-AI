import { query } from '../../db/query.js'
import { logProviderCall } from '../../providers/tracked.js'

/**
 * dub.merge — Stage kiểm tra barrier
 * Chỉ chạy khi dub.stt đã SUCCESS
 * Kiểm tra TranscriptSegment có trong DB chưa
 */
export default async function dubMerge({ project, job, setProgress }) {
  const projectId = project.id

  setProgress(20)

  // Kiểm tra TranscriptSegment (từ dub.stt)
  const transcriptSegments = await query(
    'SELECT id FROM transcript_segments WHERE project_id = ? LIMIT 1',
    [projectId]
  )

  setProgress(60)

  if (transcriptSegments.length === 0) {
    throw new Error('Thiếu TranscriptSegment từ dub.stt')
  }

  setProgress(90)

  await logProviderCall({
    projectId,
    jobId: job.id,
    provider: 'core',
    type: 'media',
    status: 'ok',
    durationMs: 0,
  })

  setProgress(100)

  return {
    transcriptSegments: transcriptSegments.length,
  }
}
