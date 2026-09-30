import path from 'path'
import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne } from '../../db/query.js'
import { replaceTranscript } from '../../services/transcriptMutationService.js'
import { extractAudio, sliceAudio, probe, compressAudioForUpload } from '../../media/mediaService.js'
import { getProvider } from '../../providers/registry.js'
import { callProvider } from '../../lib/callProvider.js'
import { projectDir, tmpDirOf, ensureDir, requireSourceFile, round2 } from '../context.js'
import {
  STT_CHUNK_SEC,
  STT_OVERLAP_SEC,
  normalizeSttLanguage,
  resolveSttSourceLanguage,
  buildSttChunks,
  filterHallucinatedSegments,
  dedupeOverlapSegments,
  hashFileContent,
} from '../sttUtils.js'
import { buildAsrCacheInput } from '../../lib/asrCacheKey.js'
import { getWhisperEffectiveConfig } from '../../providers/asr/openaiWhisper.js'

// dub.stt (docs/05 §B.2): ASR trên audio đã normalize LUFS → transcript_segments.
// Speaker diarization: cột speaker để NULL ở v1 (Whisper API không trả speaker).
export async function dubStt(ctx) {
  const { project, job, setProgress, results, signal, runToken } = ctx
  const ingest = results['dub.ingest'] || {}
  const src = requireSourceFile(project.source_video_key, 'Video nguồn')
  const tmp = ensureDir(tmpDirOf(project.id))
  setProgress(2)

  // Check abort signal
  if (signal?.aborted) throw new Error('Cancelled')

  const current = await queryOne('SELECT transcript_version FROM projects WHERE id = ?', [project.id])
  const transcriptVersion = Number(current?.transcript_version ?? project.transcript_version ?? 0)

  // Skip STT if segments already exist (video hash cache — copied from duplicate project)
  const existing = await query(
    'SELECT COUNT(*) as cnt FROM transcript_segments WHERE project_id = ?',
    [project.id]
  )
  if (existing[0]?.cnt > 0 && !ctx.forceTranscript) {
    return { segmentCount: existing[0].cnt, skipped: true, reason: 'cached' }
  }

  // Ưu tiên audio đã chuẩn hoá ở stage ingest; thiếu → tách lại từ nguồn
  let fullWav
  if (ingest.normalizedAudioKey) {
    const abs = path.join(projectDir(project.id), 'source_norm.wav')
    fullWav = fs.existsSync(abs) ? abs : null
  }
  // Explicit source language wins (languageHint); otherwise auto-detect once
  // and lock it for all chunks (per-chunk auto-detect flips on music/silence).
  const languageHint = normalizeSttLanguage(ingest.language ?? resolveSttSourceLanguage(project))
  if (!fullWav) {
    await probe(src)
    fullWav = path.join(tmp, `dub_raw_${project.id}.wav`)
    await extractAudio(src, fullWav)
    setProgress(6)
  }

  const durationSec = ingest.durationSec || (await probe(fullWav)).durationSec || (await probe(src)).durationSec

  const plan = buildSttChunks(durationSec, { chunkSec: STT_CHUNK_SEC, overlapSec: STT_OVERLAP_SEC })
  const chunks = []
  if (plan.length <= 1) {
    chunks.push({ file: fullWav, offsetSec: 0 })
  } else {
    for (let i = 0; i < plan.length; i++) {
      const f = path.join(tmp, `dub_chunk_${i}.wav`)
      await sliceAudio(fullWav, f, plan[i].start, plan[i].dur)
      chunks.push({ file: f, offsetSec: plan[i].start })
      setProgress(5 + Math.round(((i + 1) / plan.length) * 10))
    }
  }

  const asr = await getProvider(project.user_id, 'asr')
  let language = languageHint || null
  let lockedLanguage = languageHint || null
  const rawSegments = []
  for (let i = 0; i < chunks.length; i++) {
    const effectiveLang = lockedLanguage || undefined
    // Upload bản MP3 nén thay vì WAV gốc (tránh vượt giới hạn dung lượng của Groq)
    const uploadFile = path.join(tmp, `dub_up_${i}.mp3`)
    await compressAudioForUpload(chunks[i].file, uploadFile)
    const audioContentHash = await hashFileContent(uploadFile)
    const effective = getWhisperEffectiveConfig()
    const canonicalInput = buildAsrCacheInput({
      audioContentHash,
      sourceLanguage: effectiveLang,
      effectiveModel: effective.model,
      temperature: effective.temperature,
      initialPrompt: effective.initialPrompt,
      responseFormat: effective.responseFormat,
      endpoint: effective.endpoint,
    })
    const res = await callProvider({
      provider: asr.id,
      type: 'asr',
      model: effective.model,
      input: canonicalInput,
      fn: () => asr.provider.transcribe(uploadFile, { language: effectiveLang, effectiveConfig: effective }),
      userId: project.user_id,
      apiKeyId: asr.apiKeyId,
      projectId: project.id,
      jobId: job.id,
    })
    try { fs.unlinkSync(uploadFile) } catch (_) {}
    const detected = normalizeSttLanguage(res.language)
    // Lock detected language from first non-empty chunk; explicit hint never overridden.
    if (!lockedLanguage && detected && (res.segments || []).length > 0) {
      lockedLanguage = detected
    }
    if (!language || language === 'unknown') language = detected || res.language || language
    const kept = filterHallucinatedSegments(res.segments || [])
    for (const s of kept) {
      rawSegments.push({
        start: round2(s.start + chunks[i].offsetSec),
        end: round2(s.end + chunks[i].offsetSec),
        text: String(s.text || '').trim(),
        speaker: s.speaker ?? null,
        language: detected || res.language || lockedLanguage || languageHint || null,
      })
    }
    setProgress(15 + Math.round(((i + 1) / chunks.length) * 82))
  }

  // Stitch overlap window: chunk overlap is STT_OVERLAP_SEC (15s), so allow
  // negative gaps down to -15s; forward discontinuity stays tight (1.0s).
  const stitched = dedupeOverlapSegments(rawSegments, { windowSec: 1.0, overlapSec: STT_OVERLAP_SEC })
  const segments = stitched.map((s) => ({
    id: uuidv4(),
    project_id: project.id,
    index_num: 0, // reassigned below to keep ordering deterministic
    start_sec: s.start,
    end_sec: s.end,
    text: s.text,
    speaker: s.speaker ?? null,
    language: s.language,
    source: 'asr',
  }))
  segments.forEach((s, idx) => { s.index_num = idx })

  await replaceTranscript(project.id, segments, {
    expectedRevision: transcriptVersion,
    runToken,
  })

  // Dọn chunk trung gian (giữ lại normalized wav cho TTS mixing nếu cần)
  for (const c of chunks) {
    if (c.file !== fullWav) {
      try { fs.unlinkSync(c.file) } catch (_) {}
    }
  }

  return {
    segmentCount: segments.length,
    language: language || null,
    speakerDiarized: segments.some((s) => s.speaker),
  }
}

export default dubStt
