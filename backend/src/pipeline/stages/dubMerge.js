import fs from 'node:fs'
import path from 'node:path'
import { query } from '../../db/query.js'
import { logProviderCall } from '../../providers/tracked.js'
import { hasHardTranslationError } from './dubTranslate.js'
import { dedupeTranscriptSegments as mutateDedupeTranscriptSegments, findDuplicateGroups } from '../../services/transcriptMutationService.js'
import { validateNoOverlap } from '../forcedAlignService.js'
import { projectDir } from '../context.js'

function parseParams(raw) {
  try { return raw ? JSON.parse(raw) : {} } catch (_) { return {} }
}

export { findDuplicateGroups }

export async function dedupeTranscriptSegments(projectId, expectedRevision = null, options = {}) {
  return mutateDedupeTranscriptSegments(projectId, expectedRevision, options)
}

// Chọn pool segment theo mode dịch: ocrMode → rows OCR (visible subtitles là
// source of truth, ASR hallucination không được thành subtitle); STT mode →
// rows ASR. Legacy rows (source NULL, project cũ trước migration) fallback giữ
// hết để không đổi hành vi project cũ.
export function selectModePool(segments, { ocrMode = false } = {}) {
  const rows = segments || []
  if (ocrMode) {
    const ocr = rows.filter((s) => String(s.source || '').toLowerCase() === 'ocr')
    return ocr.length ? ocr : rows
  }
  const nonOcr = rows.filter((s) => String(s.source || '').toLowerCase() !== 'ocr')
  return nonOcr.length ? nonOcr : rows
}

/**
 * Validate before render (transflow doc 15 §5.0 — BLOCK_RENDER pattern).
 * Policy A: required = segments có text non-empty (khớp assertTranslateComplete).
 * Segment text rỗng = OCR noise → loại khỏi yêu cầu translation.
 *
 * @param {string} projectId
 * @returns {{valid:boolean, errors:Array, warnings:Array}}
 */
export async function validateForRender(projectId) {
  const errors = []
  const warnings = []

  // Kiểm tra 1: Có transcript segments không
  const segments = await query(
    'SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC',
    [projectId]
  )
  if (!segments.length) {
    errors.push({ code: 'NO_SEGMENTS', message: 'Không có transcript segments' })
    return { valid: false, errors, warnings }
  }

  const project = await query(
    'SELECT params FROM projects WHERE id = ?',
    [projectId]
  ).then(rows => rows[0])
  const params = parseParams(project?.params)
  const targetLanguage = params.targetLanguage || 'vi'
  const sourceLanguage = params.sourceLanguage || 'unknown'
  const enableDubbing = !!params.enableDubbing

  const isRequired = (s) => s.text && String(s.text).trim() !== ''
  const hasTranslation = (s) => s.translation && String(s.translation).trim() !== ''
  // Chỉ validate pool của mode (ocrMode → OCR rows; ASR rows không phải subtitle).
  const required = selectModePool(segments, params).filter(isRequired)

  // Kiểm tra 2: UNTRANSLATED trên required (policy A)
  const untranslated = required.filter((s) => !hasTranslation(s))
  if (untranslated.length > 0) {
    const idxList = untranslated.map((s) => `segment #${s.index_num}`).join(', ')
    if (enableDubbing) {
      errors.push({
        code: 'UNTRANSLATED_SEGMENTS',
        message: `${untranslated.length} segment chưa có translation: ${idxList}`,
        segmentIds: untranslated.map(s => s.id),
        details: untranslated.map((s) => ({ id: s.id, index: s.index_num, errors: ['missing translation'], sourceLanguage, targetLanguage })),
      })
    } else {
      warnings.push({
        code: 'SUBTITLE_SKIPPED',
        message: `${untranslated.length} segment chưa có translation (render partial, bỏ qua subtitle): ${idxList}`,
        segmentIds: untranslated.map(s => s.id),
        details: untranslated.map((s) => ({ id: s.id, index: s.index_num, errors: ['missing translation'], sourceLanguage, targetLanguage })),
      })
      for (const s of untranslated) {
        console.warn(`[RenderValidation] segment #${s.index_num} warning: errors=missing translation sourceLanguage=${sourceLanguage} targetLanguage=${targetLanguage}`)
      }
    }
  }

  // Kiểm tra 3: Duration validation (>0 và <=300s) — scope toàn bộ segments như cũ
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

  // Kiểm tra 4: timing hợp lệ + thứ tự + không overlap + không dup text — scope toàn bộ như cũ
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

  // Kiểm tra 5: semantic gate per-segment via hasHardTranslationError (Task 1)
  const semanticHard = []
  const semanticSoft = []
  const semanticHardDetails = []
  const semanticSoftDetails = []
  for (const s of required) {
    if (!hasTranslation(s)) continue
    const r = hasHardTranslationError(s.text, s.translation, targetLanguage)
    if (r.hard) {
      semanticHard.push(s)
      semanticHardDetails.push({ id: s.id, index: s.index_num, errors: r.errors, sourceLanguage, targetLanguage })
      console.log(`[RenderValidation] segment #${s.index_num} BLOCK: errors=${r.errors.join('|')} sourceLanguage=${sourceLanguage} targetLanguage=${targetLanguage}`)
    } else if (r.errors.length > 0) {
      semanticSoft.push(s)
      semanticSoftDetails.push({ id: s.id, index: s.index_num, errors: r.errors, sourceLanguage, targetLanguage })
      console.warn(`[RenderValidation] segment #${s.index_num} warning: errors=${r.errors.join('|')} sourceLanguage=${sourceLanguage} targetLanguage=${targetLanguage}`)
    }
  }
  if (semanticHard.length > 0) {
    errors.push({
      code: 'SEMANTIC_BLOCK',
      message: `${semanticHard.length} bản dịch lỗi nặng (hard): ${semanticHard.map((s) => {
        const d = semanticHardDetails.find((x) => x.id === s.id)
        return `segment #${s.index_num} [${(d?.errors || []).join('|')}]`
      }).join('; ')}`,
      segmentIds: semanticHard.map(s => s.id),
      details: semanticHardDetails,
    })
  }
  if (semanticSoft.length > 0) {
    warnings.push({
      code: 'SEMANTIC_WARNING',
      message: `${semanticSoft.length} bản dịch cảnh báo (soft, cho qua): ${semanticSoft.map((s) => `segment #${s.index_num}`).join(', ')}`,
      segmentIds: semanticSoft.map(s => s.id),
      details: semanticSoftDetails,
    })
  }

  // Kiểm tra 6: Nếu enableDubbing, kiểm tra TTS audio 1:1 + file + duration + mapping
  // Strict trên required CÓ translation (policy A).
  if (project) {
    if (params.enableDubbing) {
      const ttsTargets = required.filter(hasTranslation)
      const noTtsAudio = ttsTargets.filter(s => !s.tts_audio_id)
      if (noTtsAudio.length > 0) {
        errors.push({
          code: 'MISSING_TTS_AUDIO',
          message: `${noTtsAudio.length} segment chưa có TTS audio (cần chạy dub.ttsAlign) — BLOCK, không fallback giọng gốc`,
          segmentIds: noTtsAudio.map(s => s.id),
        })
      }
      const seen = new Map()
      const dupAudio = []
      for (const s of ttsTargets) {
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
        for (const s of ttsTargets) {
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
          const missingFiles = ttsTargets.filter((s) => {
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
      const tl = ttsTargets.map((s) => ({ segmentId: s.id, startAtSec: Number(s.start_sec), endAtSec: Number(s.end_sec) }))
      const nov = validateNoOverlap(tl)
      if (!nov.ok) errors.push({ code: 'TIMELINE_OVERLAP', message: nov.errors.join('; ') })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

/**
 * dub.merge — Post-STT barrier stage
 * Validates that dub.stt produced valid transcript segments and that
 * language config is present before proceeding to dub.translate.
 *
 * NOTE: This stage runs BEFORE dub.translate, so translations do NOT
 * exist yet. Only check STT output + language config + duration validity.
 */
export default async function dubMerge({ project, job, setProgress, runToken }) {
  const projectId = project.id
  const params = parseParams(project.params)
  const ocrMode = !!params.ocrMode

  setProgress(10)

  // Check 1: Transcript segments exist (pool theo mode: dub.ocr hoặc dub.stt)
  const allSegments = await query(
    'SELECT id, start_sec, end_sec, text, source FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC',
    [projectId]
  )
  const transcriptSegments = selectModePool(allSegments, { ocrMode })

  setProgress(30)

  if (transcriptSegments.length === 0) {
    throw new Error(`Thiếu TranscriptSegment từ ${ocrMode ? 'dub.ocr' : 'dub.stt'}`)
  }

  // Check 2: All segments have text content
  const emptyTextSegments = transcriptSegments.filter(
    s => !s.text || s.text.trim() === ''
  )

  setProgress(50)

  if (emptyTextSegments.length === transcriptSegments.length) {
    throw new Error(`Tất cả segment từ ${ocrMode ? 'dub.ocr' : 'dub.stt'} đều trống — không có nội dung để dịch`)
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
  if (!params.sourceLanguage || !params.targetLanguage) {
    throw new Error('Thiếu sourceLanguage hoặc targetLanguage trong project params')
  }

  // Auto-merge câu STT lặp nguyên văn (ASR hallucination) trước khi dịch —
  // best-effort, không throw: còn sót sẽ bị validateForRender chặn ở dub.render.
  let deduped = 0
  try {
    const current = await query('SELECT transcript_version FROM projects WHERE id = ?', [projectId])
    const r = await dedupeTranscriptSegments(projectId, Number(current?.[0]?.transcript_version ?? 0), { runToken })
    deduped = r.removedCount
  } catch (e) {
    console.warn(`[dubMerge] auto-merge bỏ qua: ${String(e?.message || e).slice(0, 160)}`)
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
    deduped,
    source: ocrMode ? 'ocr' : 'asr',
    sourceLanguage: params.sourceLanguage,
    targetLanguage: params.targetLanguage,
  }
}
