import { query, queryOne } from '../../db/query.js'
import { logProviderCall } from '../../providers/tracked.js'

/**
 * dub.merge — Stage kiểm tra barrier (docs/01 §5.1)
 * Chỉ chạy khi cả dub.stt và dub.ocr đã SUCCESS
 * Kiểm tra TranscriptSegment và OcrRegion có trong DB chưa
 * Nếu cả 2 có data → SUCCESS
 * Nếu thiếu 1 trong 2 → FAILED
 */
export default async function dubMerge({ project, job, setProgress }) {
  const projectId = project.id

  setProgress(10)

  // Kiểm tra TranscriptSegment (từ dub.stt)
  const transcriptSegments = await query(
    'SELECT id FROM transcript_segments WHERE project_id = ? LIMIT 1',
    [projectId]
  )

  setProgress(30)

  // Kiểm tra OcrRegion (từ dub.ocr)
  const ocrRegions = await query(
    'SELECT id FROM ocr_regions WHERE project_id = ? LIMIT 1',
    [projectId]
  )

  setProgress(50)

  // Nếu thiếu 1 trong 2 → FAILED
  if (transcriptSegments.length === 0) {
    throw new Error('Thiếu TranscriptSegment từ dub.stt')
  }
  if (ocrRegions.length === 0) {
    throw new Error('Thiếu OcrRegion từ dub.ocr')
  }

  // Kiểm tra status của dub.stt và dub.ocr
  const sttJob = await queryOne(
    'SELECT status FROM generation_jobs WHERE project_id = ? AND type = ?',
    [projectId, 'dub.stt']
  )
  const ocrJob = await queryOne(
    'SELECT status FROM generation_jobs WHERE project_id = ? AND type = ?',
    [projectId, 'dub.ocr']
  )

  setProgress(70)

  if (sttJob.status !== 'success') {
    throw new Error(`dub.stt không thành công (status: ${sttJob.status})`)
  }
  if (ocrJob.status !== 'success') {
    throw new Error(`dub.ocr không thành công (status: ${ocrJob.status})`)
  }

  setProgress(90)

  // Log provider call
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
    ocrRegions: ocrRegions.length,
  }
}
