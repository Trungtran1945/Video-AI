import path from 'path'
import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne } from '../../db/query.js'
import { attachTtsAudio, TranscriptRevisionConflict } from '../../services/transcriptMutationService.js'
import { isProjectRunOwned, runProjectOwned, insertProjectOwned } from '../../services/projectAdmission.js'
import {
  applyTempoAudio,
  trimAudioSilence,
  normalizeVoiceLevel,
  probe,
} from '../../media/mediaService.js'
import { ffmpeg } from '../../media/ffmpeg.js'

export function sanitizeSegmentId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'seg'
}

export function buildAudioFileMap(fitted) {
  const m = new Map()
  for (const f of fitted || []) {
    if (f?.segmentId && f?.file) m.set(String(f.segmentId), f.file)
  }
  return m
}

// TransFlow prepare_voice: trim provider silence → normalize về mức speech
// chung (−19 dBFS, peak −1 dBFS). Best-effort: thất bại giữ nguyên clip đầu vào.
async function prepareVoiceClip(inPath, segDir, segKey) {
  try {
    const cleanPath = path.join(segDir, `seg_${segKey}_clean.mp3`)
    await trimAudioSilence(inPath, cleanPath)
    let cur = inPath
    let dur = null
    if (fs.existsSync(cleanPath)) {
      const d = (await probe(cleanPath)).durationSec
      if (d > 0.05) { cur = cleanPath; dur = d }
    }
    try {
      const normPath = path.join(segDir, `seg_${segKey}_norm.mp3`)
      await normalizeVoiceLevel(cur, normPath)
      if (fs.existsSync(normPath)) {
        const d = (await probe(normPath)).durationSec
        if (d > 0.05) return { audioPath: normPath, durationSec: d }
      }
    } catch (_) {}
    return cur === inPath ? null : { audioPath: cur, durationSec: dur }
  } catch (_) {
    return null
  }
}

async function trimWavToDur(inPath, outPath, maxDurSec) {
  const dur = Math.max(0.1, maxDurSec)
  const fadeStart = Math.max(0, dur - 0.12)
  await ffmpeg([
    '-y', '-i', inPath,
    '-t', String(dur),
    '-af', `afade=t=out:st=${fadeStart.toFixed(3)}:d=0.12`,
    '-ac', '2', '-ar', '48000',
    outPath,
  ])
  return outPath
}
import { listProvidersForCapability } from '../../providers/registry.js'
import { callProvider } from '../../lib/callProvider.js'
import { classifyProviderError, ERROR_CODES } from '../../lib/providerErrors.js'
import { runWithProviderScope } from '../../lib/providerScope.js'
import { withProviderFailover } from '../../lib/providerFailover.js'
import { buildTtsCacheInput, ttsClipKey } from '../../lib/ttsCacheKey.js'
import {
  projectDir, ensureDir, round3, clamp,
} from '../context.js'
import { fitSegment, placeSegments } from '../forcedAlignService.js'
import { validateTranslation } from './dubTranslate.js'

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function assertRunOwner(projectId, runToken) {
  if (runToken && !(await isProjectRunOwned(projectId, runToken))) {
    const error = new Error('RUN_ABORTED')
    error.code = 'RUN_ABORTED'
    throw error
  }
}

// dub.ttsAlign (docs/05 §B.5 — KHÓ NHẤT): TTS + Forced Alignment ép khớp slot gốc.
// Partial success handling (transflow doc 15 §8.3): mỗi segment xử lý độc lập,
// lỗi 1 segment không làm dừng toàn bộ, thu thập partial results.
export async function dubTtsAlign(ctx) {
  const { project, job, setProgress, signal, runToken } = ctx
  const params = parseParams(project.params)
  const targetLanguage = params.targetLanguage || 'vi'

  // Check abort signal
  if (signal?.aborted) throw new Error('Cancelled')
  await assertRunOwner(project.id, runToken)

  // Generation transcript snapshot: the runner captured ONE revision for this
  // whole generation and hands it to ttsAlign, render and createOutput. Never
  // re-read projects.transcript_version here — a user edit mid-generation must
  // not change which revision this audio (and its output) is attributed to.
  const transcriptVersion = Number(ctx.transcriptVersionSnapshot)
  if (ctx.transcriptVersionSnapshot === null || ctx.transcriptVersionSnapshot === undefined
    || !Number.isInteger(transcriptVersion) || transcriptVersion < 0) {
    const error = new Error('TRANSCRIPT_SNAPSHOT_MISSING: dub.ttsAlign cần generation transcript snapshot từ pipeline runner')
    error.code = 'TRANSCRIPT_SNAPSHOT_MISSING'
    throw error
  }

  if (!params.enableDubbing || params.audioMode === 'ORIGINAL_ONLY') {
    return { skipped: true, reason: params.audioMode === 'ORIGINAL_ONLY' ? 'audioMode=ORIGINAL_ONLY' : 'enableDubbing=false', transcriptVersionSnapshot: transcriptVersion }
  }

  const segments = await query(
    `SELECT * FROM transcript_segments WHERE project_id = ? AND translation IS NOT NULL AND translation != ''
     ORDER BY start_sec ASC`,
    [project.id]
  )
  if (!segments.length) throw new Error('Không có câu dịch nào để lồng tiếng — dub.translate chưa chạy?')

  const ttsCandidates = await listProvidersForCapability(project.user_id, 'tts')
  if (!ttsCandidates.length) throw new Error('Chưa cấu hình TTS provider — kiểm tra trang API Keys / Cài đặt')
  const llmCandidates = await listProvidersForCapability(project.user_id, 'llm').catch(() => [])
  const llm = llmCandidates[0] || null
  const segDir = ensureDir(path.join(projectDir(project.id), 'audio_segments'))
  setProgress(3)

  // Resume semantics (TransFlow tts_clip_key): KHÔNG xóa audio_segments.
  // Mỗi segment có fingerprint (provider/voice/text/speed); file còn hợp lệ
  // thì reuse, chỉ synth phần thiếu. Đổi text/voice → fingerprint đổi → synth mới.
  try { fs.mkdirSync(segDir, { recursive: true }) } catch (_) {}

  // Provider hỗ trợ tốc độ native (Edge/OpenAI) → synthesize đúng tốc độ,
  // tránh méo giọng do filter atempo (docs/05 §B.5).
  // ZeroTTS upstream ONNX model không hỗ trợ tham số speed trực tiếp, nên sử dụng FFmpeg tempo fitting.
  // TransFlow MAX_FIT_TEMPO = 1.35: Chặn tốc độ tối đa ở 1.35x để giữ pitch tự nhiên,
  // không biến giọng đọc thành sóc chuột lách chách.
  const supportsNativeSpeedFor = (cand) => cand?.id === 'edge_tts' || cand?.id === 'openai_tts'
  const SPEED_MIN = 0.5
  const SPEED_MAX = 1.35
  const KEY_LEVEL_CODES = new Set([
    ERROR_CODES.PROVIDER_QUOTA_EXCEEDED,
    ERROR_CODES.PROVIDER_AUTH_FAILED,
    ERROR_CODES.PROVIDER_PERMISSION_DENIED,
    ERROR_CODES.PROVIDER_MODEL_NOT_FOUND,
  ])
  const RATE_LIMIT_STREAK_TO_STOP = 3

  // Partial success tracking (transflow doc 15 §8.3)
  const fitted = []
  const errors = []
  let successCount = 0
  let errorCount = 0
  let cacheHitCount = 0
  let stopError = null
  let rateLimitStreak = 0
  let firstErrorCode = null
  const usedProviderIds = new Map()

  await runWithProviderScope(`dub.ttsAlign:${project.id}`, async () => {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (stopError) {
      errorCount++
      errors.push({
        segmentId: seg.id,
        indexNum: seg.index_num,
        error: stopError.message,
        errorCode: stopError.errorCode || firstErrorCode || null,
      })
      continue
    }
    const slotDur = Math.max(0.2, Number(seg.end_sec) - Number(seg.start_sec))
    const nextStart = segments[i + 1] ? Number(segments[i + 1].start_sec) : Infinity
    // TransFlow pause-expansion: Dòng phụ đề sở hữu slot của nó + khoảng lặng (pause)
    // trước câu tiếp theo (chừa buffer 60ms) để không bị ép tốc độ giả hoặc rút gọn oan uổng.
    const roomDur = Math.max(slotDur, nextStart !== Infinity ? Math.max(slotDur, nextStart - 0.06 - Number(seg.start_sec)) : slotDur + 2.0)
    let translation = seg.translation

    // Bounded retry cho TTS transient (tối đa 1 retry = 2 attempts).
    // Quota/auth/model → cooldown/exclude + failover provider khác (không retry
    // cùng key). Key-level error → dừng batch, segment còn lại failed không gọi provider.
    let done = false
    for (let ttsAttempt = 0; ttsAttempt <= 1 && !done; ttsAttempt++) {
      try {
        // Sinh audio + căn chỉnh cho 1 bản dịch. Nếu provider hỗ trợ tốc độ native,
        // synthesize lại đúng tốc độ (speed = tempo cần thiết) thay vì dùng atempo.
        const segKey = sanitizeSegmentId(seg.id)
        const makeAudio = async (text) => {
          let audio = await synthWithFailover(ttsCandidates, text, segDir, segKey, job, project.id, 1, project.user_id)
          if (audio.cacheHit) cacheHitCount++
          // Loại bỏ khoảng lặng thừa ở đầu và cuối clip do TTS sinh ra (TransFlow prepare_voice)
          try {
            const prepared = await prepareVoiceClip(audio.audioPath, segDir, segKey)
            if (prepared) audio = { ...audio, ...prepared }
          } catch (_) {}

          let fit = fitSegment(audio.durationSec, slotDur, { roomDur })
          const nativeCapable = supportsNativeSpeedFor(
            ttsCandidates.find((c) => c.id === audio.provider) || ttsCandidates[0]
          )
          if (nativeCapable) {
            let targetSpeed = 1
            if (fit.tempo !== 1) {
              targetSpeed = fit.tempo
            } else if (fit.action === 'shorten' && audio.durationSec > roomDur) {
              targetSpeed = audio.durationSec / roomDur
            }
            if (targetSpeed !== 1) {
              const speed = clamp(targetSpeed, SPEED_MIN, SPEED_MAX)
              const re = await synthWithFailover(ttsCandidates, text, segDir, segKey, job, project.id, speed, project.user_id)
              audio = { ...re, audioPath: re.audioPath }
              if (re.cacheHit) cacheHitCount++
              try {
                const cleanPath = path.join(segDir, `seg_${segKey}_clean.mp3`)
                await trimAudioSilence(audio.audioPath, cleanPath)
                if (fs.existsSync(cleanPath)) {
                  const cleanedDur = (await probe(cleanPath)).durationSec
                  if (cleanedDur > 0.05) {
                    audio = { ...audio, audioPath: cleanPath, durationSec: cleanedDur }
                  }
                }
              } catch (_) {}
              fit = fitSegment(audio.durationSec, slotDur, { roomDur })
            }
          }
          if (audio.providerId) usedProviderIds.set(audio.providerId, (usedProviderIds.get(audio.providerId) || 0) + 1)
          return { audio, fit }
        }

        let { audio, fit } = await makeAudio(translation)

        // Đọc dài hơn cả khi hớt tốc độ tối đa → rút gọn bản dịch rồi TTS lại (tối đa 2 lần).
        // Chỉ chấp nhận bản dịch rút gọn khi VƯỢT QUA semantic gate (validateTranslation).
        let attempt = 0
        while (fit.action === 'shorten' && llm && attempt < 2) {
          const shortened = await shortenTranslation(llm, seg.text, translation, fit.targetCharsRatio, job, project.id, targetLanguage, attempt, project.user_id)
          if (!shortened || shortened === translation) break
          const candidate = await makeAudio(shortened)
          translation = shortened
          audio = candidate.audio
          fit = candidate.fit
          attempt++
        }

        // Áp tempo + padding → file wav chuẩn 48k stereo đặt đúng offset
        // (với provider native speed, tempo thường = 1 nên không bị méo giọng).
        const finalPath = path.join(segDir, `seg_fit_${segKey}.wav`)
        await applyTempoAudio(audio.audioPath, finalPath, {
          tempo: fit.tempo,
          padBeforeSec: fit.padBeforeSec,
          padAfterSec: fit.padAfterSec,
        })
        try { fs.unlinkSync(audio.audioPath) } catch (_) {}
        let finalDur = (await probe(finalPath)).durationSec || fit.effectiveDurSec
        // Physical consistency: audio thật không được tràn sang segment kế (chừa 60ms gap)
        const maxAllowed = Math.max(slotDur, nextStart !== Infinity ? Math.max(0.1, nextStart - 0.06 - Number(seg.start_sec)) : slotDur + 2.0)
        if (finalDur > maxAllowed) {
          const trimmed = path.join(segDir, `seg_fit_${segKey}_trim.wav`)
          await trimWavToDur(finalPath, trimmed, maxAllowed)
          try { fs.unlinkSync(finalPath) } catch (_) {}
          try { fs.renameSync(trimmed, finalPath) } catch (_) {}
          finalDur = (await probe(finalPath)).durationSec || maxAllowed
        }
        if (finalDur <= 0) throw new Error(`audio rỗng sau fit (segment ${seg.index_num})`)

        // Manual translation trong DB là source of truth (manual > generated):
        // bản rút gọn (shorten) chỉ dùng in-memory cho TTS synthesis, KHÔNG
        // overwrite DB. Redub dùng lại translation hiện tại, không mất sửa tay.
        // NOTE: chỉ xóa intermediate clip khi nó là file tạm KHÔNG phải clip
        // cache dùng chung (clip_*.mp3 được giữ để rerun reuse).
        fitted.push({
          segmentId: seg.id,
          indexNum: seg.index_num,
          file: finalPath,
          effectiveDurSec: round3(Math.min(finalDur, maxAllowed)),
          action: fit.action,
          tempo: fit.tempo,
          providerId: audio.providerId || ttsCandidates[0]?.id || 'unknown',
        })
        successCount++
        rateLimitStreak = 0
        done = true
      } catch (err) {
        const cls = classifyProviderError(err)
        const code = err?.code === 'NO_PROVIDER_AVAILABLE' ? (err.errorCode || cls.code) : cls.code
        if (!firstErrorCode) firstErrorCode = code
        if (code === ERROR_CODES.PROVIDER_RATE_LIMITED) {
          rateLimitStreak++
          if (rateLimitStreak >= RATE_LIMIT_STREAK_TO_STOP) {
            stopError = err
            stopError.errorCode = code
          } else if (ttsAttempt < 1 && cls.retryable === true) {
            await sleepMs(800 * (ttsAttempt + 1))
            continue
          }
        } else if (KEY_LEVEL_CODES.has(code)) {
          // Quota/auth/model: dừng batch ngay, segment còn lại không gọi provider.
          stopError = err
          stopError.errorCode = code
        } else if (cls.retryable === true && ttsAttempt < 1) {
          // Chỉ retry TRANSIENT retryable (timeout/network/unavailable), bounded 1 lần.
          await sleepMs(800 * (ttsAttempt + 1))
          continue
        }
        // Ghi nhận lỗi, tiếp tục segment tiếp theo để thu thập full diagnostics,
        // nhưng stage sẽ FAILED strict ở cuối nếu có bất kỳ lỗi nào.
        errorCount++
        errors.push({
          segmentId: seg.id,
          indexNum: seg.index_num,
          error: err.message,
          errorCode: code,
        })
        console.warn(`[dubTtsAlign] Segment ${seg.index_num} lỗi [${code}]: ${err.message}`)
        break
      }
    }

    setProgress(3 + Math.round(((i + 1) / segments.length) * 82))
  }
  })

  // Invariant: enableDubbing=true → COMPLETED chỉ khi 100% required TTS hợp lệ.
  // Không success giả partial (render BLOCK_RENDER sẽ chặn, nhưng stage phải fail trước).
  // Partial files được GIỮ (không xóa) để rerun chỉ synth phần thiếu.
  if (errorCount > 0) {
    const missing = errors.map((e) => e.indexNum)
    const err = new Error(
      `dub.ttsAlign incomplete: ${successCount}/${segments.length} audio thành công` +
      ` (${errorCount} lỗi: ${errors.slice(0, 5).map((e) => `#${e.indexNum}:${String(e.error || '').slice(0, 120)}`).join('; ')})`
    )
    err.completedSegments = successCount
    err.missingSegments = missing
    err.totalSegments = segments.length
    err.errorCode = firstErrorCode
    throw err
  }

  // Không cho chồng tiếng (docs/05 §B.5 invariant) — nhưng QUAN TRỌNG: neo mỗi
  // đoạn giọng vào đúng start_sec gốc (timeline video nguồn), KHÔNG dùng
  // sequenceSegments dịch startAt về sau khi gặp đoạn chồng lấp. Việc dịch này
  // gây lệch (chạy trễ) và cộng dồn theo thời gian trong hội thoại dày đặc.
  // Thay vào đó: startAt = start_sec gốc; effectiveDur bị chặp lại vừa đủ lấp
  // slot [start_sec, end_sec] (hoặc đến start_sec đoạn kế) để không chồng tiếng.
  const sequenced = placeSegments(
    fitted.map((f, i) => ({
      startSec: Number(segments.find(s => s.id === f.segmentId)?.start_sec) || 0,
      endSec: Number(segments.find(s => s.id === f.segmentId)?.end_sec) || 0,
      effectiveDurSec: f.effectiveDurSec,
    }))
  )

  // Ghi audios rows + cập nhật tts_audio_id
  for (let i = 0; i < fitted.length; i++) {
    const f = fitted[i]
    await assertRunOwner(project.id, runToken)
    const audioRow = await insertProjectOwned(project.id, runToken, 'audios', {
      id: uuidv4(),
      project_id: project.id,
      kind: 'voice',
      storage_key: null, // file ở project dir, không cần storage key public
      duration_sec: round3(f.effectiveDurSec),
      provider: f.providerId || ttsCandidates[0]?.id || 'unknown',
    })
    if (!audioRow) {
      const error = new Error('RUN_ABORTED')
      error.code = 'RUN_ABORTED'
      throw error
    }
    try {
      await attachTtsAudio(project.id, f.segmentId, audioRow.id, transcriptVersion, runToken)
    } catch (error) {
      await runProjectOwned(project.id, runToken, 'DELETE FROM audios WHERE id = ?', [audioRow.id])
      if (error instanceof TranscriptRevisionConflict) {
        const conflict = new Error('TRANSCRIPT_CHANGED_DURING_TTS')
        conflict.transient = true
        throw conflict
      }
      throw error
    }
    f.audioId = audioRow.id
    f.startAtSec = sequenced[i].startAtSec
    f.endAtSec = sequenced[i].endAtSec
  }

  // Trả về kết quả partial success (transflow doc 15 §8.3)
  const primaryProvider = [...usedProviderIds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    || ttsCandidates[0]?.id || 'unknown'
  return {
    dubbedCount: fitted.length,
    skippedCount: (await countAll(project.id)) - fitted.length,
    errorCount,
    cacheHitCount,
    // Persisted with this job's success — the frozen generation revision that
    // dub.render (and output provenance) reuses on resume.
    transcriptVersionSnapshot: transcriptVersion,
    errors: errors.length > 0 ? errors : undefined,
    alignments: fitted.map((f) => ({
      segmentId: f.segmentId,
      audioId: f.audioId,
      startAtSec: f.startAtSec,
      endAtSec: f.endAtSec,
      action: f.action,
      tempo: f.tempo,
    })),
    voiceProvider: primaryProvider,
    // Stage COMPLETED nếu có ít nhất 1 segment thành công
    stageStatus: successCount > 0 ? 'completed' : 'failed',
  }
}

// Canonical TTS synthesis with filesystem resume + provider failover.
// Clip file is content-addressed by (provider/voice/text/speed): same input →
// same file → no provider call. Changed text/voice → new file → new call.
async function synthWithFailover(candidates, text, segDir, segKey, job, projectId, speed = 1, userId = null) {
  const clean = String(text || '').trim()
  if (!clean) throw new Error('TTS text rỗng')
  const out = await withProviderFailover(
    { capability: 'TTS', candidates, maxAttempts: Math.min(4, candidates.length) },
    async (cand) => {
      const voice = cand.provider.voice || cand.provider.model || cand.id
      const model = cand.provider.model || cand.id
      const canonical = buildTtsCacheInput({ provider: cand.id, voice, model, text: clean, speed })
      const clip = ttsClipKey(canonical)
      const clipPath = path.join(segDir, `clip_${clip.slice(0, 16)}.mp3`)
      // Filesystem resume: valid clip already on disk → reuse without provider call.
      try {
        if (fs.existsSync(clipPath)) {
          const d = (await probe(clipPath)).durationSec
          if (d > 0.05) {
            return { audioPath: clipPath, durationSec: d, provider: cand.id, providerId: cand.id, model, cacheHit: true }
          }
        }
      } catch (_) {}
      const res = await callProvider({
        provider: cand.id,
        type: 'tts',
        model,
        input: canonical,
        fn: () => cand.provider.synthesize({ text: clean, outPath: clipPath, speed }),
        userId,
        apiKeyId: cand.apiKeyId,
        projectId,
        jobId: job.id,
      })
      const dur = res?.durationSec || (await probe(res?.audioPath || clipPath)).durationSec
      return { audioPath: res?.audioPath || clipPath, durationSec: dur, provider: cand.id, providerId: cand.id, model, cacheHit: false }
    }
  )
  return out.result
}

export async function shortenTranslation(llm, sourceText, translation, ratio, job, projectId, targetLanguage = 'vi', attempt = 0, userId = null) {
  // Best-effort cosmetic call: fail fast (no retry storm) when the LLM is
  // exhausted — the stage keeps the original translation and fits via tempo.
  try {
    const targetWords = Math.max(2, Math.round((String(translation || '').trim().split(/\s+/).length) * (ratio || 0.7)))
    const prompt =
      `Rút gọn câu lồng tiếng sau còn khoảng ${targetWords} từ nhưng BẮT BUỘC GIỮ NGUYÊN Ý CHÍNH, tên riêng, con số, phủ định, nghi vấn. Tự nhiên như lồng tiếng:\n"${translation}"\n` +
      `Chỉ trả về DUY NHẤT 1 câu rút gọn không giải thích, không tiêu đề, không để trong ngoặc hay dấu nháy.`

    const res = await callProvider({
      provider: llm.id,
      type: 'llm',
      model: llm.provider.model || llm.id,
      input: {
        prompt,
        temperature: 0.2,
        maxOutputTokens: 150,
        maxRetries: 0,
      },
      fn: () => llm.provider.complete({
        prompt,
        temperature: 0.2,
        maxOutputTokens: 150,
        maxRetries: 0,
      }),
      userId,
      apiKeyId: llm.apiKeyId,
      projectId,
      jobId: job?.id,
    })

    let text = String(res?.text || '').trim()
    text = text.replace(/[*_`]/g, '')
    const lines = text.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.endsWith(':') && !l.startsWith('#'))
    const candidateLine = lines[0] || ''
    const cleaned = candidateLine
      .replace(/^[\d+.)\-*•\s]+/, '')
      .replace(/^["'“”(\s]+|["'“”)\s]+$/g, '')
      .trim()

    // BẮT BUỘC: Bản dịch rút gọn phải vượt qua semantic gate (số/phủ định/thực thể/ngôn ngữ).
    // Nếu fail gate (ví dụ LLM trả lời giải thích, bịa số, mất phủ định) -> coi như thất bại và giữ bản dịch gốc.
    if (cleaned && validateTranslation(sourceText, cleaned, targetLanguage).ok) {
      return cleaned
    }
    return null
  } catch (_) {
    return null
  }
}

async function countAll(projectId) {
  const row = await queryOne(`SELECT COUNT(*) as c FROM transcript_segments WHERE project_id = ?`, [projectId])
  return row?.c || 0
}

function parseParams(raw) {
  try { return raw ? JSON.parse(raw) : {} } catch (_) { return {} }
}

export default dubTtsAlign
