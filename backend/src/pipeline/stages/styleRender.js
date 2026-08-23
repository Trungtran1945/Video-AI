import fs from 'node:fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { query } from '../../db/query.js'
import {
  conformVideo,
  applyMotionImage,
  concatClips,
  buildVoiceTrack,
  mixAudio,
  makeThumbnail,
  probe,
} from '../../media/mediaService.js'
import { ffmpeg } from '../../media/ffmpeg.js'
import { TRANSITION_DURATION } from '../alignService.js'
import { config } from '../../config.js'
import {
  tmpDirOf,
  ensureDir,
  resolveStorageKey,
  requireSourceFile,
  round2,
  dimsForAspect,
  isImageAsset,
  insertMany,
} from '../context.js'

export async function styleRender(ctx) {
  const { project, setProgress } = ctx
  const clips = await query(
    'SELECT * FROM timeline_clips WHERE project_id = ? ORDER BY order_index ASC',
    [project.id]
  )
  if (!clips.length) throw new Error('Chưa có storyboard — hãy retry từ stage style.storyboard')

  const assets = await query('SELECT * FROM assets WHERE project_id = ?', [project.id])
  const assetById = new Map(assets.map((a) => [a.id, a]))

  const analyzeResult = ctx.results?.['style.analyze'] || {}
  const profile = analyzeResult.styleProfile || {}
  const { width, height } = dimsForAspect(profile.aspectRatio || project.aspect_ratio || '9:16')
  const grade = {
    contrast: Number(profile.color?.contrast) || 1.05,
    saturation: Number(profile.color?.saturation) || 1.1,
  }
  const zoomMax = Array.isArray(profile.motion?.zoomRange) ? profile.motion.zoomRange[1] : 1.12

  const tmp = ensureDir(tmpDirOf(project.id))
  setProgress(5)

  const slices = []
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    const asset = assetById.get(clip.ref_id)
    if (!asset) throw new Error(`Asset không tồn tại (${clip.ref_id}) — tạo lại dự án hoặc retry từ storyboard`)
    const abs = requireSourceFile(asset.storage_key, `Asset ${asset.storage_key}`)
    const out = path.join(tmp, `shot_${clip.order_index}.mp4`)
    let sliced
    if (isImageAsset(asset)) {
      const durSec = Math.max(0.8, (Number(clip.out_sec) - Number(clip.in_sec)) / (Number(clip.speed) || 1))
      sliced = await applyMotionImage({ src: abs, out, durationSec: durSec, width, height, zoomMax, grade })
    } else {
      sliced = await conformVideo({
        src: abs,
        inSec: Number(clip.in_sec) || 0,
        outSec: Number(clip.out_sec),
        speed: Number(clip.speed) || 1,
        width,
        height,
        grade,
        out,
      })
    }
    slices.push({ file: sliced.file, durationSec: sliced.durationSec, transitionOut: clip.transition_out || null })
    setProgress(5 + Math.round(((i + 1) / clips.length) * 50))
  }

  const concatFile = path.join(tmp, 'concat.mp4')
  await concatClips(slices, concatFile, { transitionDuration: TRANSITION_DURATION })

  const positions = [0]
  let running = slices[0].durationSec
  for (let i = 1; i < slices.length; i++) {
    const overlap = slices[i - 1].transitionOut ? TRANSITION_DURATION : 0
    positions.push(round2(Math.max(0, running - overlap)))
    running = positions[i] + slices[i].durationSec
  }
  const totalDuration = round2(positions[positions.length - 1] + slices[slices.length - 1].durationSec)
  setProgress(65)

  const audios = await query('SELECT * FROM audios WHERE project_id = ?', [project.id])
  const voiceAudio = audios
    .filter((a) => String(a.kind || '').toLowerCase() === 'voice')
    .map((a) => ({ a, abs: resolveStorageKey(a.storage_key) }))
    .find((x) => x.abs && fs.existsSync(x.abs))
  const musicAsset = assets
    .filter((a) => String(a.kind || '').toLowerCase() === 'audio')
    .map((a) => ({ a, abs: resolveStorageKey(a.storage_key) }))
    .find((x) => x.abs && fs.existsSync(x.abs))

  const mixed = path.join(tmp, 'mixed.mp4')
  if (voiceAudio) {
    await buildVoiceTrack([{ file: voiceAudio.abs, offsetSec: 0 }], totalDuration + 0.5, path.join(tmp, 'voice.wav'))
    await mixAudio(concatFile, path.join(tmp, 'voice.wav'), musicAsset ? musicAsset.abs : null, mixed, {
      videoDurationSec: totalDuration,
    })
  } else if (musicAsset) {
    await buildVoiceTrack([{ file: musicAsset.abs, offsetSec: 0 }], totalDuration + 0.5, path.join(tmp, 'music.wav'))
    await mixAudio(concatFile, path.join(tmp, 'music.wav'), null, mixed, { videoDurationSec: totalDuration })
  } else {
    await ffmpeg(['-y', '-i', concatFile, '-c:v', 'copy', '-an', '-movflags', '+faststart', mixed])
  }
  setProgress(80)

  const outId = uuidv4()
  const outputsAbs = ensureDir(path.join(config.storageDir, 'outputs'))
  const finalPath = path.join(outputsAbs, `${outId}.mp4`)
  fs.copyFileSync(mixed, finalPath)

  const info = await probe(finalPath)
  try {
    await makeThumbnail(finalPath, Math.min(2, info.durationSec / 2), path.join(outputsAbs, 'thumbs', `${outId}.jpg`))
  } catch (_) {}

  await insertMany('outputs', [
    {
      id: outId,
      project_id: project.id,
      storage_key: `outputs/${outId}.mp4`,
      status: 'success',
      duration_sec: round2(info.durationSec),
      thumbnail_key: `outputs/thumbs/${outId}.jpg`,
    },
  ])

  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch (_) {}
  setProgress(99)

  return { outputId: outId, outputKey: `outputs/${outId}.mp4`, durationSec: round2(info.durationSec) }
}

export default styleRender
