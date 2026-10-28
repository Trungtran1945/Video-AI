import fs from 'node:fs'
import path from 'path'
import { extractAudio, sliceAudio, probe, compressAudioForUpload } from '../../media/mediaService.js'
import { listProvidersForCapability } from '../../providers/registry.js'
import { callProvider } from '../../lib/callProvider.js'
import { classifyProviderError } from '../../lib/providerErrors.js'
import { runWithProviderScope } from '../../lib/providerScope.js'
import { withProviderFailover } from '../../lib/providerFailover.js'
import { projectDir, tmpDirOf, ensureDir, requireSourceFile, writeJson, toStorageKey, round2 } from '../context.js'
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

export async function summaryTranscribe(ctx) {
  const { project, job, setProgress, signal, forceTranscript } = ctx
  const src = requireSourceFile(project.source_video_key, 'Video nguồn (phim)')
  const dir = projectDir(project.id)
  const tmp = ensureDir(tmpDirOf(project.id))
  setProgress(2)

  // Skip-cache đối xứng DUB: transcript.json đã có segments + !forceTranscript →
  // bỏ qua STT (tránh transcribe lại tốn quota). Version-guard: chỉ skip khi
  // transcript_version DB khớp version ghi trong file (stale → chạy lại).
  try {
    const { queryOne: qOne } = await import('../../db/query.js')
    const row = await qOne('SELECT transcript_version FROM projects WHERE id = ?', [project.id])
    const dbVersion = Number(row?.transcript_version ?? 0)
    const cachedPath = path.join(dir, 'transcript.json')
    if (!forceTranscript && fs.existsSync(cachedPath)) {
      const cached = JSON.parse(fs.readFileSync(cachedPath, 'utf8'))
      if (Array.isArray(cached?.segments) && cached.segments.length > 0 && Number(cached.transcriptVersion ?? 0) === dbVersion) {
        return { transcriptKey: toStorageKey(cachedPath), language: cached.language || null, segmentCount: cached.segments.length, durationSec: cached.durationSec, skipped: true, reason: 'cached' }
      }
    }
  } catch (_) {}

  // Check abort signal
  if (signal?.aborted) throw new Error('Cancelled')

  const info = await probe(src)
  if (!info.durationSec) throw new Error('Không đọc được thời lượng video nguồn')

  const fullWav = path.join(tmp, 'source_full.wav')
  // NOTE: project.language is the TARGET/summary language — never use it as
  // the STT source hint. Resolve from params.sourceLanguage, else auto-detect.
  const initialHint = resolveSttSourceLanguage(project)
  const plan = buildSttChunks(info.durationSec, { chunkSec: STT_CHUNK_SEC, overlapSec: STT_OVERLAP_SEC })
  const chunks = []
  if (plan.length <= 1) {
    chunks.push({ file: await extractAudio(src, fullWav), offsetSec: 0 })
  } else {
    await extractAudio(src, fullWav)
    for (let i = 0; i < plan.length; i++) {
      const f = path.join(tmp, `chunk_${i}.wav`)
      await sliceAudio(fullWav, f, plan[i].start, plan[i].dur)
      chunks.push({ file: f, offsetSec: plan[i].start })
      setProgress(2 + Math.round(((i + 1) / plan.length) * 8))
    }
  }

  const asrCandidates = await listProvidersForCapability(project.user_id, 'asr')
  if (!asrCandidates.length) {
    const e = new Error('Chưa cấu hình API key cho ASR/STT')
    e.code = 'PROV_001'
    throw e
  }
  let language = initialHint || null
  let lockedLanguage = initialHint || null
  const rawSegments = []
  await runWithProviderScope(`summary.transcribe:${project.id}`, async () => {
  for (let i = 0; i < chunks.length; i++) {
    const effectiveLang = lockedLanguage || undefined
    // Nén MP3 như nhánh dub để đồng nhất chất lượng + tránh giới hạn upload.
    const uploadFile = path.join(tmp, `sum_up_${i}.mp3`)
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
    let res
    try {
      const out = await withProviderFailover(
        { capability: 'STT', candidates: asrCandidates, maxAttempts: Math.min(4, asrCandidates.length) },
        (cand) => callProvider({
          provider: cand.id,
          type: 'asr',
          model: effective.model,
          input: { ...canonicalInput, provider: cand.id },
          fn: () => cand.provider.transcribe(uploadFile, { language: effectiveLang, effectiveConfig: effective }),
          userId: project.user_id,
          apiKeyId: cand.apiKeyId,
          projectId: project.id,
          jobId: job.id,
        })
      )
      res = out.result
    } catch (err) {
      try { fs.unlinkSync(uploadFile) } catch (_) {}
      err.completedChunks = i
      err.totalChunks = chunks.length
      err.errorCode = err.code === 'NO_PROVIDER_AVAILABLE' ? (err.errorCode || classifyProviderError(err).code) : classifyProviderError(err).code
      throw err
    }
    try { fs.unlinkSync(uploadFile) } catch (_) {}
    const detected = normalizeSttLanguage(res.language)
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
      })
    }
    setProgress(12 + Math.round(((i + 1) / chunks.length) * 84))
  }
  })
  const segments = dedupeOverlapSegments(rawSegments, { windowSec: 1.0, overlapSec: STT_OVERLAP_SEC })

  // Provenance: bump projects.transcript_version + ghi version vào file để
  // skip-cache và stale-check đối xứng với DUB (transcriptVersionSnapshot).
  let transcriptVersion = 0
  try {
    const { queryOne: qOne2, run: run2 } = await import('../../db/query.js')
    const cur = await qOne2('SELECT transcript_version FROM projects WHERE id = ?', [project.id])
    transcriptVersion = Number(cur?.transcript_version ?? 0) + 1
    await run2('UPDATE projects SET transcript_version = ? WHERE id = ?', [transcriptVersion, project.id])
  } catch (_) {}

  const transcriptPath = writeJson(path.join(dir, 'transcript.json'), {
    language: language || initialHint || 'unknown',
    durationSec: info.durationSec,
    segments,
    transcriptVersion,
  })

  try { fs.unlinkSync(fullWav) } catch (_) {}
  for (const c of chunks) {
    if (c.file !== fullWav) {
      try { fs.unlinkSync(c.file) } catch (_) {}
    }
  }

  return {
    transcriptKey: toStorageKey(transcriptPath),
    language: language || null,
    segmentCount: segments.length,
    durationSec: round2(info.durationSec),
    transcriptVersion,
  }
}

export default summaryTranscribe
