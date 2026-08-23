import fs from 'node:fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { query } from '../../db/query.js'
import {
  clipSlice,
  concatClips,
  buildVoiceTrack,
  mixAudio,
  addSubtitles,
  makeThumbnail,
  probe,
} from '../../media/mediaService.js'
import { TRANSITION_DURATION } from '../alignService.js'
import { config } from '../../config.js'
import {
  tmpDirOf,
  ensureDir,
  resolveStorageKey,
  requireSourceFile,
  round2,
  insertMany,
} from '../context.js'

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  async function lane() {
    while (next < items.length) {
      const idx = next++
      results[idx] = await worker(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}

export async function summaryRender(ctx) {
  const { project, setProgress } = ctx
  const src = requireSourceFile(project.source_video_key, 'Video nguồn (phim)')
  const clips = await query(
    'SELECT * FROM timeline_clips WHERE project_id = ? ORDER BY order_index ASC',
    [project.id]
  )
  if (!clips.length) throw new Error('Chưa có timeline — hãy retry từ stage summary.align')

  const scenes = await query('SELECT id FROM scenes WHERE project_id = ?', [project.id])
  const sceneIds = new Set(scenes.map((s) => s.id))

  const subtitles = await query(
    `SELECT storage_key FROM subtitles WHERE project_id = ? ORDER BY created_date DESC`,
    [project.id]
  )
  const srtAbs = subtitles[0] ? resolveStorageKey(subtitles[0].storage_key) : null

  const tmp = ensureDir(tmpDirOf(project.id))
  const mezDir = ensureDir(path.join(tmp, 'mez'))

  setProgress(3)
  const slices = await mapWithConcurrency(clips, 2, async (clip) => {
    if (!sceneIds.has(clip.ref_id)) {
      throw new Error(`Clip tham chiếu cảnh không tồn tại (${clip.ref_id}) — retry từ stage summary.sceneDetect`)
    }
    const out = path.join(mezDir, `clip_${clip.order_index}.mp4`)
    const sliced = await clipSlice({
      src,
      inSec: Number(clip.in_sec),
      outSec: Number(clip.out_sec),
      speed: Number(clip.speed) || 1,
      out,
    })
    return { file: sliced.file, durationSec: sliced.durationSec, transitionOut: clip.transition_out || null }
  })
  setProgress(55)

  const concatFile = path.join(tmp, 'concat.mp4')
  await concatClips(slices, concatFile, { transitionDuration: TRANSITION_DURATION })

  // Recompute real positions from encoded durations so the voice track stays in sync
  const positions = []
  let running = slices[0].durationSec
  positions[0] = 0
  for (let i = 1; i < slices.length; i++) {
    const overlap = slices[i - 1].transitionOut ? TRANSITION_DURATION : 0
    positions[i] = round2(Math.max(0, running - overlap))
    running = positions[i] + slices[i].durationSec
  }
  setProgress(65)

  const firstPosBySegment = new Map()
  clips.forEach((clip, i) => {
    const seg = clip.voice_audio_id || '_none_'
    if (!firstPosBySegment.has(seg)) firstPosBySegment.set(seg, positions[i])
  })
  const audios = await query('SELECT * FROM audios WHERE project_id = ?', [project.id])
  const audioById = new Map(audios.map((a) => [a.id, a]))
  const voiceEntries = []
  for (const [segId, pos] of firstPosBySegment.entries()) {
    if (segId === '_none_') continue
    const a = audioById.get(segId)
    if (!a) continue
    const abs = resolveStorageKey(a.storage_key)
    if (abs && fs.existsSync(abs)) voiceEntries.push({ file: abs, offsetSec: pos })
  }
  if (!voiceEntries.length) throw new Error('Không tìm thấy bản ghi giọng đọc — retry từ stage summary.align')

  const totalDuration = round2(positions[positions.length - 1] + slices[slices.length - 1].durationSec)
  const voiceTrack = path.join(tmp, 'voice.wav')
  await buildVoiceTrack(voiceEntries, totalDuration + 0.5, voiceTrack)
  setProgress(75)

  const mixed = path.join(tmp, 'mixed.mp4')
  await mixAudio(concatFile, voiceTrack, null, mixed, { videoDurationSec: totalDuration })

  setProgress(85)
  const outId = uuidv4()
  const outputsAbs = ensureDir(path.join(config.storageDir, 'outputs'))
  const finalPath = path.join(outputsAbs, `${outId}.mp4`)
  if (srtAbs && fs.existsSync(srtAbs)) {
    await addSubtitles(mixed, srtAbs, finalPath)
  } else {
    fs.copyFileSync(mixed, finalPath)
  }

  const info = await probe(finalPath)
  const thumbRel = `outputs/thumbs/${outId}.jpg`
  try {
    await makeThumbnail(finalPath, Math.min(3, info.durationSec / 2), path.join(path.dirname(finalPath), 'thumbs', `${outId}.jpg`))
  } catch (_) {}

  await insertMany('outputs', [
    {
      id: outId,
      project_id: project.id,
      storage_key: `outputs/${outId}.mp4`,
      status: 'success',
      duration_sec: round2(info.durationSec),
      thumbnail_key: thumbRel,
    },
  ])

  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch (_) {}
  setProgress(99)

  return {
    outputId: outId,
    outputKey: `outputs/${outId}.mp4`,
    durationSec: round2(info.durationSec),
    subtitleBurned: Boolean(srtAbs && fs.existsSync(srtAbs)),
  }
}

export default summaryRender
