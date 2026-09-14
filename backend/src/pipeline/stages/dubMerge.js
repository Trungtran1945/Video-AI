import { query } from '../../db/query.js'
import { logProviderCall } from '../../providers/tracked.js'

/**
 * dub.merge — Post-STT barrier stage
 * Validates that dub.stt produced valid transcript segments and that
 * language config is present before proceeding to dub.translate.
 *
 * NOTE: This stage runs BEFORE dub.translate, so translations do NOT
 * exist yet. Only check STT output + language config + duration validity.
 */
export default async function dubMerge({ project, job, setProgress }) {
  const projectId = project.id

  setProgress(10)

  // Check 1: Transcript segments exist (produced by dub.stt)
  const transcriptSegments = await query(
    'SELECT id, start_sec, end_sec, text FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC',
    [projectId]
  )

  setProgress(30)

  if (transcriptSegments.length === 0) {
    throw new Error('Thiếu TranscriptSegment từ dub.stt')
  }

  // Check 2: All segments have text content from STT
  const emptyTextSegments = transcriptSegments.filter(
    s => !s.text || s.text.trim() === ''
  )

  setProgress(50)

  if (emptyTextSegments.length === transcriptSegments.length) {
    throw new Error('Tất cả segment từ dub.stt đều trống — không có nội dung để dịch')
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
    emptyTextSegments: emptyTextSegments.length,
    sourceLanguage: params.sourceLanguage,
    targetLanguage: params.targetLanguage,
  }
}

function parseParams(raw) {
  try { return raw ? JSON.parse(raw) : {} } catch (_) { return {} }
}
