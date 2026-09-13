import { query } from '../../db/query.js'
import { logProviderCall } from '../../providers/tracked.js'

/**
 * dub.merge — Stage kiểm tra barrier
 * Kiểm tra TranscriptSegment + Translation + Duration + Language config
 */
export default async function dubMerge({ project, job, setProgress }) {
  const projectId = project.id

  setProgress(10)

  // Check 1: Transcript segments exist
  const transcriptSegments = await query(
    'SELECT id, translation, start_sec, end_sec FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC',
    [projectId]
  )

  setProgress(30)

  if (transcriptSegments.length === 0) {
    throw new Error('Thiếu TranscriptSegment từ dub.stt')
  }

  // Check 2: All segments have translation
  const segmentsWithoutTranslation = transcriptSegments.filter(
    s => !s.translation || s.translation.trim() === ''
  )

  setProgress(50)

  if (segmentsWithoutTranslation.length > 0) {
    throw new Error(`${segmentsWithoutTranslation.length} segment chưa có bản dịch. Vui lòng dịch tất cả segment trước khi render.`)
  }

  // Check 3: Duration validation (>0 and reasonable)
  const invalidDurationSegments = transcriptSegments.filter(s => {
    const duration = s.end_sec - s.start_sec
    return duration <= 0 || duration > 300 // max 5 minutes per segment
  })

  setProgress(70)

  if (invalidDurationSegments.length > 0) {
    throw new Error(`${invalidDurationSegments.length} segment có duration không hợp lệ (phải >0 và <=300s)`)
  }

  // Check 4: Language config
  const params = parseParams(project.params)
  if (!params.sourceLanguage || !params.targetLanguage) {
    throw new Error('Thiếu sourceLanguage hoặc targetLanguage trong project params')
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

function parseParams(raw) {
  try { return raw ? JSON.parse(raw) : {} } catch (_) { return {} }
}
