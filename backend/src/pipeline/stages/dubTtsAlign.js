import path from 'path'
import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, updateById, insert } from '../../db/query.js'
import {
  applyTempoAudio,
  probe,
} from '../../media/mediaService.js'
import { getProvider } from '../../providers/registry.js'
import { tracked } from '../../providers/tracked.js'
import {
  projectDir, ensureDir, round3, clamp,
} from '../context.js'
import { fitSegment, placeSegments } from '../forcedAlignService.js'

// dub.ttsAlign (docs/05 §B.5 — KHÓ NHẤT): TTS + Forced Alignment ép khớp slot gốc.
export async function dubTtsAlign(ctx) {
  const { project, job, setProgress } = ctx
  const params = parseParams(project.params)

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

  const fitted = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const slotDur = Math.max(0.2, Number(seg.end_sec) - Number(seg.start_sec))
    let translation = seg.translation

    // Sinh audio + căn chỉnh cho 1 bản dịch. Nếu provider hỗ trợ tốc độ native,
    // synthesize lại đúng tốc độ (speed = tempo cần thiết) thay vì dùng atempo.
    const makeAudio = async (text) => {
      let audio = await synth(tts, text, path.join(segDir, `seg_${String(i).padStart(5, '0')}.mp3`), job, project.id, 1)
      let fit = fitSegment(audio.durationSec, slotDur)
      if (supportsNativeSpeed && fit.tempo !== 1) {
        const speed = clamp(fit.tempo, SPEED_MIN, SPEED_MAX)
        audio = await synth(tts, text, audio.audioPath, job, project.id, speed)
        fit = fitSegment(audio.durationSec, slotDur)
      }
      return { audio, fit }
    }

    let { audio, fit } = await makeAudio(translation)

    // Đọc dài hơn cả khi hớt tốc độ tối đa → rút gọn bản dịch rồi TTS lại (tối đa 2 lần)
    let attempt = 0
    while (fit.action === 'shorten' && llm && attempt < 2) {
      const shortened = await shortenTranslation(llm, translation, fit.targetCharsRatio, job, project.id, attempt)
      if (!shortened || shortened === translation) break
      translation = shortened
      ;({ audio, fit } = await makeAudio(translation))
      attempt++
    }

    // Áp tempo + padding → file wav chuẩn 48k stereo đặt đúng offset
    // (với provider native speed, tempo thường = 1 nên không bị méo giọng).
    const finalPath = path.join(segDir, `seg_fit_${String(i).padStart(5, '0')}.wav`)
    await applyTempoAudio(audio.audioPath, finalPath, {
      tempo: fit.tempo,
      padBeforeSec: fit.padBeforeSec,
      padAfterSec: fit.padAfterSec,
    })
    try { fs.unlinkSync(audio.audioPath) } catch (_) {}
    const finalDur = (await probe(finalPath)).durationSec || fit.effectiveDurSec

    fitted.push({
      segmentId: seg.id,
      indexNum: seg.index_num,
      file: finalPath,
      effectiveDurSec: round3(Math.min(finalDur, slotDur * 1.08 + 0.01)),
      action: fit.action,
      tempo: fit.tempo,
    })
    await updateById('transcript_segments', seg.id, { translation })
    setProgress(3 + Math.round(((i + 1) / segments.length) * 82))
  }

  // Không cho chồng tiếng (docs/05 §B.5 invariant) — nhưng QUAN TRỌNG: neo mỗi
  // đoạn giọng vào đúng start_sec gốc (timeline video nguồn), KHÔNG dùng
  // sequenceSegments dịch startAt về sau khi gặp đoạn chồng lấp. Việc dịch này
  // gây lệch (chạy trễ) và cộng dồn theo thời gian trong hội thoại dày đặc.
  // Thay vào đó: startAt = start_sec gốc; effectiveDur bị chặp lại vừa đủ lấp
  // slot [start_sec, end_sec] (hoặc đến start_sec đoạn kế) để không chồng tiếng.
  const sequenced = placeSegments(
    fitted.map((f, i) => ({
      startSec: Number(segments[i].start_sec),
      endSec: Number(segments[i].end_sec),
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

  return {
    dubbedCount: fitted.length,
    skippedCount: (await countAll(project.id)) - fitted.length,
    alignments: fitted.map((f) => ({
      segmentId: f.segmentId,
      audioId: f.audioId,
      startAtSec: f.startAtSec,
      endAtSec: f.endAtSec,
      action: f.action,
      tempo: f.tempo,
    })),
    voiceProvider: tts.id,
  }
}

async function synth(tts, text, outPath, job, projectId, speed = 1) {
  return tracked(
    { projectId, jobId: job.id, provider: tts.id, type: 'tts' },
    () => tts.provider.synthesize({ text, outPath, speed })
  )
}

async function shortenTranslation(llm, translation, ratio, job, projectId, attempt = 0) {
  try {
    const res = await tracked(
      { projectId, jobId: job.id, provider: llm.id, type: 'llm' },
      () => llm.provider.complete({
        prompt:
          `Rút gọn câu lồng tiếng sau còn khoảng ${Math.round(ratio * 100)}% độ dài nhưng GIỮ NGUYÊN Ý CHÍNH, tự nhiên như lồng tiếng:\n"${translation}"\n` +
          `Trả về DUY NHẤT chuỗi kết quả, không giải thích${attempt > 0 ? ', cắt gọn hơn nữa' : ''}.`,
        temperature: 0.3,
        maxOutputTokens: 200,
      })
    )
    const cleaned = res.text.replace(/^["'\s]+|["'\s]+$/g, '').trim()
    return cleaned || null
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
