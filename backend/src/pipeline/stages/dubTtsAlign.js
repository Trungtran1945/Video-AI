import path from 'path'
import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, updateById, insert } from '../../db/query.js'
import {
  applyTempoAudio,
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

async function trimWavToDur(inPath, outPath, maxDurSec) {
  await ffmpeg(['-y', '-i', inPath, '-t', String(Math.max(0.1, maxDurSec)), '-ac', '2', '-ar', '48000', outPath])
  return outPath
}
import { getProvider } from '../../providers/registry.js'
import { callProvider } from '../../lib/callProvider.js'
import { classifyProviderError, ERROR_KINDS } from '../../lib/providerErrors.js'
import {
  projectDir, ensureDir, round3, clamp,
} from '../context.js'
import { fitSegment, placeSegments } from '../forcedAlignService.js'
import { validateTranslation } from './dubTranslate.js'

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// dub.ttsAlign (docs/05 §B.5 — KHÓ NHẤT): TTS + Forced Alignment ép khớp slot gốc.
// Partial success handling (transflow doc 15 §8.3): mỗi segment xử lý độc lập,
// lỗi 1 segment không làm dừng toàn bộ, thu thập partial results.
export async function dubTtsAlign(ctx) {
  const { project, job, setProgress, signal } = ctx
  const params = parseParams(project.params)
  const targetLanguage = params.targetLanguage || 'vi'

  // Check abort signal
  if (signal?.aborted) throw new Error('Cancelled')

  if (!params.enableDubbing) {
    return { skipped: true, reason: 'enableDubbing=false' }
  }

  const segments = await query(
    `SELECT * FROM transcript_segments WHERE project_id = ? AND translation IS NOT NULL AND translation != ''
     ORDER BY start_sec ASC`,
    [project.id]
  )
  if (!segments.length) throw new Error('Không có câu dịch nào để lồng tiếng — dub.translate chưa chạy?')

  const tts = await getProvider(project.user_id, 'tts')
  const llm = await getProvider(project.user_id, 'llm').catch(() => null)
  const segDir = ensureDir(path.join(projectDir(project.id), 'audio_segments'))
  setProgress(3)

  // Xoá audio segment cũ trước khi tạo lại (RESETS['dub.ttsAlign'] đã xoá audios rows)
  try { fs.rmSync(segDir, { recursive: true, force: true }); fs.mkdirSync(segDir, { recursive: true }) } catch (_) {}

  // Provider hỗ trợ tốc độ native (Edge/OpenAI) → synthesize đúng tốc độ,
  // tránh méo giọng do filter atempo (docs/05 §B.5).
  const supportsNativeSpeed = tts.id === 'edge_tts' || tts.id === 'openai_tts'
  const SPEED_MIN = 0.5
  const SPEED_MAX = 2.0

  // Partial success tracking (transflow doc 15 §8.3)
  const fitted = []
  const errors = []
  let successCount = 0
  let errorCount = 0

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const slotDur = Math.max(0.2, Number(seg.end_sec) - Number(seg.start_sec))
    let translation = seg.translation

    // Bounded retry cho TTS transient (tối đa 1 retry = 2 attempts).
    // PERMANENT/CONFIGURATION → không retry. Provider fallback hợp lệ
    // hiện chưa có TTS thứ hai nên ghi nhận lỗi và fail strict ở cuối.
    let lastErr = null
    let done = false
    for (let ttsAttempt = 0; ttsAttempt <= 1 && !done; ttsAttempt++) {
      try {
        // Sinh audio + căn chỉnh cho 1 bản dịch. Nếu provider hỗ trợ tốc độ native,
        // synthesize lại đúng tốc độ (speed = tempo cần thiết) thay vì dùng atempo.
        const segKey = sanitizeSegmentId(seg.id)
        const makeAudio = async (text) => {
          let audio = await synth(tts, text, path.join(segDir, `seg_${segKey}.mp3`), job, project.id, 1, project.user_id)
          let fit = fitSegment(audio.durationSec, slotDur)
          if (supportsNativeSpeed) {
            let targetSpeed = 1
            if (fit.tempo !== 1) {
              targetSpeed = fit.tempo
            } else if (fit.action === 'shorten' && audio.durationSec > slotDur) {
              targetSpeed = audio.durationSec / slotDur
            }
            if (targetSpeed !== 1) {
              const speed = clamp(targetSpeed, SPEED_MIN, SPEED_MAX)
              audio = await synth(tts, text, audio.audioPath, job, project.id, speed, project.user_id)
              fit = fitSegment(audio.durationSec, slotDur)
            }
          }
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
        // Physical consistency: audio thật không được dài hơn slot hoặc tràn sang segment kế
        const nextStart = segments[i + 1] ? Number(segments[i + 1].start_sec) : Infinity
        const maxAllowed = Math.min(slotDur, Math.max(0.1, nextStart - Number(seg.start_sec)))
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
        fitted.push({
          segmentId: seg.id,
          indexNum: seg.index_num,
          file: finalPath,
          effectiveDurSec: round3(Math.min(finalDur, maxAllowed)),
          action: fit.action,
          tempo: fit.tempo,
        })
        successCount++
        done = true
      } catch (err) {
        lastErr = err
        const cls = classifyProviderError(err)
        // Chỉ retry TRANSIENT, bounded 1 lần với backoff.
        if (cls.kind === ERROR_KINDS.TRANSIENT && ttsAttempt < 1) {
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
        })
        console.warn(`[dubTtsAlign] Segment ${seg.index_num} lỗi: ${err.message}`)
        break
      }
    }

    setProgress(3 + Math.round(((i + 1) / segments.length) * 82))
  }

  // Invariant: enableDubbing=true → COMPLETED chỉ khi 100% required TTS hợp lệ.
  // Không success giả partial (render BLOCK_RENDER sẽ chặn, nhưng stage phải fail trước).
  if (errorCount > 0) {
    throw new Error(
      `dub.ttsAlign incomplete: ${successCount}/${segments.length} audio thành công` +
      ` (${errorCount} lỗi: ${errors.slice(0, 5).map((e) => `#${e.indexNum}:${String(e.error || '').slice(0, 120)}`).join('; ')})`
    )
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
    const audioRow = await insert('audios', {
      id: uuidv4(),
      project_id: project.id,
      kind: 'voice',
      storage_key: null, // file ở project dir, không cần storage key public
      duration_sec: round3(f.effectiveDurSec),
      provider: tts.id,
    })
    await updateById('transcript_segments', f.segmentId, { tts_audio_id: audioRow.id })
    f.audioId = audioRow.id
    f.startAtSec = sequenced[i].startAtSec
    f.endAtSec = sequenced[i].endAtSec
  }

  // Trả về kết quả partial success (transflow doc 15 §8.3)
  return {
    dubbedCount: fitted.length,
    skippedCount: (await countAll(project.id)) - fitted.length,
    errorCount,
    errors: errors.length > 0 ? errors : undefined,
    alignments: fitted.map((f) => ({
      segmentId: f.segmentId,
      audioId: f.audioId,
      startAtSec: f.startAtSec,
      endAtSec: f.endAtSec,
      action: f.action,
      tempo: f.tempo,
    })),
    voiceProvider: tts.id,
    // Stage COMPLETED nếu có ít nhất 1 segment thành công
    stageStatus: successCount > 0 ? 'completed' : 'failed',
  }
}

async function synth(tts, text, outPath, job, projectId, speed = 1, userId = null) {
  return callProvider({
    provider: tts.id,
    type: 'tts',
    model: tts.provider.model || tts.id,
    input: { text, outPath, speed },
    fn: () => tts.provider.synthesize({ text, outPath, speed }),
    userId,
    apiKeyId: tts.apiKeyId,
    projectId,
    jobId: job.id,
  })
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
