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
  projectDir, ensureDir, round3,
} from '../context.js'
import { fitSegment, sequenceSegments } from '../forcedAlignService.js'

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

  const fitted = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const slotDur = Math.max(0.2, Number(seg.end_sec) - Number(seg.start_sec))
    let translation = seg.translation
    let audio = await synth(tts, translation, path.join(segDir, `seg_${String(i).padStart(5, '0')}.mp3`), job, project.id)
    let fit = fitSegment(audio.durationSec, slotDur)

    // Đọc dài hơn cả khi hớt tốc độ tối đa → rút gọn bản dịch rồi TTS lại đúng 1 lần (docs/05 §B.5 3b)
    if (fit.action === 'shorten' && llm) {
      const shortened = await shortenTranslation(llm, translation, fit.targetCharsRatio, job, project.id)
      if (shortened && shortened !== translation) {
        translation = shortened
        audio = await synth(tts, translation, audio.audioPath, job, project.id)
        fit = fitSegment(audio.durationSec, slotDur, { canShorten: false })
      }
    }

    // Áp tempo + padding → file wav chuẩn 48k stereo đặt đúng offset
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

  // Không cho chồng tiếng (docs/05 §B.5 invariant) — co biên khi tràn
  const sequenced = sequenceSegments(
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

async function synth(tts, text, outPath, job, projectId) {
  return tracked(
    { projectId, jobId: job.id, provider: tts.id, type: 'tts' },
    () => tts.provider.synthesize({ text, outPath })
  )
}

async function shortenTranslation(llm, translation, ratio, job, projectId) {
  try {
    const res = await tracked(
      { projectId, jobId: job.id, provider: llm.id, type: 'llm' },
      () => llm.provider.complete({
        prompt:
          `Rút gọn câu lồng tiếng sau còn khoảng ${Math.round(ratio * 100)}% độ dài nhưng giữ ý chính, tự nhiên:\n"${translation}"\n` +
          `Trả về DUY NHẤT chuỗi kết quả.`,
        temperature: 0.3,
        maxOutputTokens: 200,
      })
    )
    return res.text.replace(/^["'\s]+|["'\s]+$/g, '')
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
