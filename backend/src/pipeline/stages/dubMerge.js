import fs from 'node:fs'
import path from 'node:path'
import { query } from '../../db/query.js'
import { logProviderCall } from '../../providers/tracked.js'
import { validateTranslation } from './dubTranslate.js'
import { validateNoOverlap } from '../forcedAlignService.js'
import { projectDir } from '../context.js'

function parseParams(raw) {
  try { return raw ? JSON.parse(raw) : {} } catch (_) { return {} }
}

/**
 * Validate before render (transflow doc 15 §5.0 — BLOCK_RENDER pattern).
 * Kiểm tra tất cả điều kiện cần thiết TRƯỚC khi kích hoạt Stage RENDER.
 *
 * @param {string} projectId
 * @returns {{valid:boolean, errors:Array<{code:string, message:string, segmentId?:string}>}}
 */
export async function validateForRender(projectId) {
  const errors = []

  // Kiểm tra 1: Có transcript segments không
  const segments = await query(
    'SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC',
    [projectId]
  )
  if (!segments.length) {
    errors.push({ code: 'NO_SEGMENTS', message: 'Không có transcript segments' })
    return { valid: false, errors }
  }

  // Kiểm tra 2: Có translation không
  const untranslated = segments.filter(s => !s.translation || s.translation.trim() === '')
  if (untranslated.length > 0) {
    errors.push({
      code: 'UNTRANSLATED_SEGMENTS',
      message: `${untranslated.length} segment chưa có translation`,
      segmentIds: untranslated.map(s => s.id),
    })
  }

  // Kiểm tra 3: Duration validation (>0 và <=300s)
  const invalidDuration = segments.filter(s => {
    const dur = (Number(s.end_sec) || 0) - (Number(s.start_sec) || 0)
    return dur <= 0 || dur > 300
  })
  if (invalidDuration.length > 0) {
    errors.push({
      code: 'INVALID_DURATION',
      message: `${invalidDuration.length} segment có duration không hợp lệ (phải >0 và <=300s)`,
      segmentIds: invalidDuration.map(s => s.id),
    })
  }

  // Kiểm tra 4: timing hợp lệ + thứ tự + không overlap + không dup text
  const sorted = [...segments].sort((a, b) => (Number(a.start_sec) || 0) - (Number(b.start_sec) || 0))
  const badTiming = sorted.filter(s => !(Number(s.end_sec) > Number(s.start_sec)) || Number(s.start_sec) < 0)
  if (badTiming.length > 0) {
    errors.push({ code: 'INVALID_TIMING', message: `${badTiming.length} segment timing invalid (0<=start<end)`, segmentIds: badTiming.map(s => s.id) })
  }
  for (let i = 1; i < sorted.length; i++) {
    if (Number(sorted[i].start_sec) < Number(sorted[i - 1].end_sec) - 0.05) {
      errors.push({ code: 'OVERLAP', message: `segment ${sorted[i].id} overlap segment trước`, segmentIds: [sorted[i - 1].id, sorted[i].id] })
      break
    }
  }
  const dupText = sorted.filter((s, i) => i > 0 && String(s.text || '').trim() && String(s.text || '').trim() === String(sorted[i - 1].text || '').trim() && Math.abs(Number(s.start_sec) - Number(sorted[i - 1].end_sec)) < 1.0)
  if (dupText.length > 0) {
    errors.push({ code: 'DUPLICATE_SUBTITLE', message: `${dupText.length} subtitle trùng lặp liên tiếp`, segmentIds: dupText.map(s => s.id) })
  }

  // Kiểm tra 5: semantic translation gate (non-empty đã check ở #2)
  const project = await query(
    'SELECT params FROM projects WHERE id = ?',
    [projectId]
  ).then(rows => rows[0])
  const params = parseParams(project?.params)
  const targetLanguage = params.targetLanguage || 'vi'
  const semanticBad = segments.filter(s => s.translation && s.translation.trim() && !validateTranslation(s.text, s.translation, targetLanguage).ok)
  if (semanticBad.length > 0) {
    errors.push({ code: 'SEMANTIC_MISMATCH', message: `${semanticBad.length} bản dịch fail semantic gate (số/phủ định/thực thể/ngôn ngữ)`, segmentIds: semanticBad.map(s => s.id) })
  }

  // Kiểm tra 6: Nếu enableDubbing, kiểm tra TTS audio 1:1 + file + duration + mapping
  if (project) {
    if (params.enableDubbing) {
      const required = segments.filter(s => s.translation && s.translation.trim())
      const noTtsAudio = required.filter(s => !s.tts_audio_id)
      if (noTtsAudio.length > 0) {
        errors.push({
          code: 'MISSING_TTS_AUDIO',
          message: `${noTtsAudio.length} segment chưa có TTS audio (cần chạy dub.ttsAlign) — BLOCK, không fallback giọng gốc`,
          segmentIds: noTtsAudio.map(s => s.id),
        })
      }
      const seen = new Map()
      const dupAudio = []
      for (const s of required) {
        if (!s.tts_audio_id) continue
        if (seen.has(s.tts_audio_id)) dupAudio.push(s.id)
        else seen.set(s.tts_audio_id, s.id)
      }
      if (dupAudio.length > 0) {
        errors.push({ code: 'DUPLICATE_AUDIO', message: `${dupAudio.length} segment dùng chung audio (mapping 1:1 vi phạm)`, segmentIds: dupAudio })
      }
      // File + duration tương thích slot (best-effort, không crash khi thiếu ffprobe)
      try {
        const audios = await query('SELECT id, duration_sec FROM audios WHERE project_id = ?', [projectId])
        const byId = new Map(audios.map((a) => [String(a.id), a]))
        const badFiles = []
        for (const s of required) {
          if (!s.tts_audio_id) continue
          const a = byId.get(String(s.tts_audio_id))
          const slot = Number(s.end_sec) - Number(s.start_sec)
          if (!a || !(Number(a.duration_sec) > 0)) { badFiles.push(s.id); continue }
          if (Number(a.duration_sec) > slot + 0.5) { badFiles.push(s.id); continue }
        }
        if (badFiles.length > 0) {
          errors.push({ code: 'INVALID_TTS_DURATION', message: `${badFiles.length} audio duration không tương thích slot`, segmentIds: badFiles })
        }
        // Physical file presence for ID-named wavs (warn-level → block only when dir exists but file missing)
        const segDir = path.join(projectDir(projectId), 'audio_segments')
        if (fs.existsSync(segDir)) {
          const files = new Set(fs.readdirSync(segDir))
          const missingFiles = required.filter((s) => {
            if (!s.tts_audio_id) return false
            const key = String(s.id).replace(/[^A-Za-z0-9_-]/g, '_')
            return ![...files].some((f) => f.startsWith('seg_fit_') && f.endsWith('.wav') && f.includes(key))
          })
          if (missingFiles.length > 0) {
            errors.push({ code: 'MISSING_TTS_FILE', message: `${missingFiles.length} segment thiếu file wav riêng`, segmentIds: missingFiles.map(s => s.id) })
          }
        }
      } catch (_) {}
      // Timeline placement không overlap (dựa trên transcript timing)
      const tl = required.map((s) => ({ segmentId: s.id, startAtSec: Number(s.start_sec), endAtSec: Number(s.end_sec) }))
      const nov = validateNoOverlap(tl)
      if (!nov.ok) errors.push({ code: 'TIMELINE_OVERLAP', message: nov.errors.join('; ') })
    }
  }

  return { valid: errors.length === 0, errors }
}

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
