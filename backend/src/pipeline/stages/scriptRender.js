import fs from 'node:fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { query } from '../../db/query.js'
import {
  applyMotionImage,
  concatClips,
  buildVoiceTrack,
  mixAudio,
  burnSubtitlesStyled,
  makeThumbnail,
  probe,
} from '../../media/mediaService.js'
import { createOutput } from '../../services/outputService.js'
import { config } from '../../config.js'
import { isProjectRunOwned } from '../../services/projectAdmission.js'
import {
  tmpDirOf,
  ensureDir,
  resolveStorageKey,
  dimsForAspect,
  parseJsonSafe,
  round2,
} from '../context.js'

async function assertRunOwner(projectId, runToken) {
  if (runToken && !(await isProjectRunOwned(projectId, runToken))) {
    const error = new Error('RUN_ABORTED')
    error.code = 'RUN_ABORTED'
    throw error
  }
}

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

// script.render — motion slides → concat → voice track → mix → optional ASS
// burn → probe. The output row is inserted only AFTER every validation passes,
// so a broken render never leaves a publishable row behind.
export async function scriptRender(ctx) {
  const { project, setProgress, signal, runToken, scriptVersionSnapshot } = ctx
  await assertRunOwner(project.id, runToken)
  if (signal?.aborted) throw new Error('Cancelled')

  const clips = await query(
    'SELECT * FROM timeline_clips WHERE project_id = ? ORDER BY order_index ASC',
    [project.id]
  )
  if (!clips.length) throw new Error('Chưa có timeline — hãy retry từ stage script.align')

  const assetIds = [...new Set(clips.map((c) => c.ref_id).filter(Boolean))]
  const assets = assetIds.length
    ? await query('SELECT * FROM assets WHERE project_id = ?', [project.id])
    : []
  const assetById = new Map(assets.map((a) => [a.id, a]))
  for (const clip of clips) {
    const asset = assetById.get(clip.ref_id)
    if (!asset) throw new Error(`Clip #${clip.order_index} tham chiếu ảnh không tồn tại — retry từ stage script.image`)
    const abs = resolveStorageKey(asset.storage_key)
    if (!abs || !fs.existsSync(abs)) {
      throw new Error(`File ảnh của clip #${clip.order_index} không tồn tại — retry từ stage script.image`)
    }
  }

  const tmp = ensureDir(tmpDirOf(project.id))
  const segDir = ensureDir(path.join(tmp, 'segments'))
  const { width, height } = dimsForAspect(project.aspect_ratio)

  setProgress(3)
  const slices = await mapWithConcurrency(clips, 2, async (clip, idx) => {
    if (signal?.aborted) throw new Error('Cancelled')
    const asset = assetById.get(clip.ref_id)
    const durationSec = Math.max(0.05, Number(clip.out_sec) - Number(clip.in_sec || 0))
    const out = path.join(segDir, `seg_${String(idx).padStart(3, '0')}.mp4`)
    const rendered = await applyMotionImage({
      src: resolveStorageKey(asset.storage_key),
      out,
      durationSec,
      width,
      height,
      zoomMax: 1.08,
    })
    return { file: rendered.file, durationSec: rendered.durationSec, transitionOut: null }
  })
  await assertRunOwner(project.id, runToken)
  setProgress(60)

  const concatFile = path.join(tmp, 'concat.mp4')
  await concatClips(slices, concatFile, { transitionDuration: 0 })
  await assertRunOwner(project.id, runToken)
  setProgress(70)

  const voiceIds = [...new Set(clips.map((c) => c.voice_audio_id).filter(Boolean))]
  const audios = voiceIds.length
    ? await query('SELECT * FROM audios WHERE project_id = ?', [project.id])
    : []
  const audioById = new Map(audios.map((a) => [a.id, a]))
  const voiceEntries = []
  for (const clip of clips) {
    if (!clip.voice_audio_id) continue
    const audio = audioById.get(clip.voice_audio_id)
    if (!audio) continue
    const abs = resolveStorageKey(audio.storage_key)
    if (abs && fs.existsSync(abs)) {
      voiceEntries.push({ file: abs, offsetSec: Number(clip.start_at_sec) || 0 })
    }
  }
  if (!voiceEntries.length) throw new Error('Không tìm thấy bản ghi giọng đọc — retry từ stage script.align')

  const lastClip = clips[clips.length - 1]
  const totalDuration = round2(
    (Number(lastClip.start_at_sec) || 0) + Math.max(0, Number(lastClip.out_sec) - Number(lastClip.in_sec || 0))
  )
  const voiceTrack = path.join(tmp, 'voice.wav')
  await buildVoiceTrack(voiceEntries, totalDuration + 0.5, voiceTrack)
  setProgress(78)

  const mixed = path.join(tmp, 'mixed.mp4')
  await mixAudio(concatFile, voiceTrack, null, mixed, { videoDurationSec: totalDuration })
  await assertRunOwner(project.id, runToken)
  setProgress(86)

  const params = parseJsonSafe(project.params, {}) || {}
  const assRow = await query(
    `SELECT storage_key FROM subtitles WHERE project_id = ? AND format = 'ass' ORDER BY created_date DESC LIMIT 1`,
    [project.id]
  )
  const assAbs = assRow[0] ? resolveStorageKey(assRow[0].storage_key) : null
  const burnSubtitles = params.burnSubtitles !== false && Boolean(assAbs && fs.existsSync(assAbs))

  const outId = uuidv4()
  const outputsAbs = ensureDir(path.join(config.storageDir, 'outputs'))
  const finalPath = path.join(outputsAbs, `${outId}.mp4`)
  await assertRunOwner(project.id, runToken)
  if (burnSubtitles) {
    await burnSubtitlesStyled(mixed, assAbs, finalPath)
  } else {
    fs.copyFileSync(mixed, finalPath)
  }

  const info = await probe(finalPath)
  const byteSize = (() => {
    try { return fs.statSync(finalPath).size } catch (_) { return 0 }
  })()
  if (!(info.durationSec > 0.5) || !(info.width > 0) || !(info.height > 0) || !info.hasAudio || !(byteSize > 0)) {
    try { fs.unlinkSync(finalPath) } catch (_) {}
    throw new Error(
      `SCRIPT_RENDER_INVALID: file render không hợp lệ (duration=${info.durationSec}, ${info.width}x${info.height}, audio=${info.hasAudio}, bytes=${byteSize})`
    )
  }
  await assertRunOwner(project.id, runToken)

  const thumbsAbs = ensureDir(path.join(outputsAbs, 'thumbs'))
  const thumbRel = `outputs/thumbs/${outId}.jpg`
  try {
    await makeThumbnail(finalPath, Math.min(3, info.durationSec / 2), path.join(thumbsAbs, `${outId}.jpg`))
  } catch (err) {
    console.warn(`[scriptRender] makeThumbnail failed project=${project.id}: ${String(err?.message || err).slice(0, 160)}`)
  }

  await assertRunOwner(project.id, runToken)
  const scriptVersion = Number.isInteger(scriptVersionSnapshot)
    ? scriptVersionSnapshot
    : Number(project.script_version ?? 0)
  await createOutput({
    id: outId,
    projectId: project.id,
    storageKey: `outputs/${outId}.mp4`,
    status: 'success',
    durationSec: round2(info.durationSec),
    thumbnailKey: thumbRel,
    scriptVersion,
    runToken,
  })

  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch (_) {}
  setProgress(99)

  return {
    outputId: outId,
    outputKey: `outputs/${outId}.mp4`,
    durationSec: round2(info.durationSec),
    subtitleBurned: burnSubtitles,
  }
}

export default scriptRender
