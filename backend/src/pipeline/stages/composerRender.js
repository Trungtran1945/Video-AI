import fs from 'node:fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { query } from '../../db/query.js'
import {
  applyMotionImage,
  concatClips,
  buildVoiceTrack,
  burnSubtitlesStyled,
  makeThumbnail,
  probe,
} from '../../media/mediaService.js'
import { ffmpeg } from '../../media/ffmpeg.js'
import { createOutput } from '../../services/outputService.js'
import { config } from '../../config.js'
import { isProjectRunOwned } from '../../services/projectAdmission.js'
import {
  tmpDirOf,
  ensureDir,
  resolveStorageKey,
  dimsForAspect,
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

export async function composerRender(ctx = {}) {
  const { project, setProgress = () => {}, signal, runToken } = ctx
  if (runToken) await assertRunOwner(project.id, runToken)
  if (signal?.aborted) throw new Error('Cancelled')

  setProgress(5)

  const clips = await query(
    'SELECT * FROM timeline_clips WHERE project_id = ? ORDER BY order_index ASC',
    [project.id]
  )
  if (!clips.length) throw new Error('Không có clip nào trên timeline để kết xuất')

  const assets = await query('SELECT * FROM assets WHERE project_id = ?', [project.id])
  const assetById = new Map(assets.map((a) => [a.id, a]))

  const audios = await query('SELECT * FROM audios WHERE project_id = ?', [project.id])
  const audioById = new Map(audios.map((a) => [a.id, a]))

  const tmp = ensureDir(tmpDirOf(project.id))
  const segDir = ensureDir(path.join(tmp, 'segments'))
  const prepDir = ensureDir(path.join(tmp, 'prepared'))
  const { width, height } = dimsForAspect(project.aspect_ratio || '16:9')

  // Calculate total duration
  let maxEnd = 0
  for (const c of clips) {
    const end = (Number(c.start_at_sec) || 0) + Math.max(0, Number(c.out_sec) - Number(c.in_sec || 0))
    if (end > maxEnd) maxEnd = end
  }
  const totalDuration = round2(Math.max(1, maxEnd))

  // 1. Build Visual Track (Multi-layer: Background + Slideshow)
  const bgClips = clips.filter((c) => c.clip_type === 'background')
  const bgAsset = bgClips[0] ? assetById.get(bgClips[0].asset_id) : null
  const bgFile = bgAsset ? resolveStorageKey(bgAsset.storage_key) : null
  const defaultBgColor = project?.params?.defaultBackground || '#0F1117'

  const imageClips = clips.filter((c) => c.clip_type === 'image' || (!c.clip_type && c.source_type === 'ASSET'))
  let concatFile = path.join(tmp, 'concat.mp4')
  let rawSlideshow = path.join(tmp, 'raw_slideshow.mp4')

  if (imageClips.length > 0) {
    setProgress(15)
    const slices = await mapWithConcurrency(imageClips, 2, async (clip, idx) => {
      if (signal?.aborted) throw new Error('Cancelled')
      const prepImg = path.join(prepDir, `img_${clip.id}.png`)
      const asset = assetById.get(clip.asset_id)
      const srcImg = fs.existsSync(prepImg) ? prepImg : (asset ? resolveStorageKey(asset.storage_key) : null)
      if (!srcImg || !fs.existsSync(srcImg)) {
        throw new Error(`File ảnh cho clip #${clip.order_index} không tồn tại`)
      }

      const durationSec = Math.max(0.5, Number(clip.out_sec) - Number(clip.in_sec || 0))
      const out = path.join(segDir, `seg_${String(idx).padStart(3, '0')}.mp4`)
      const rendered = await applyMotionImage({
        src: srcImg,
        out,
        durationSec,
        width,
        height,
        zoomMax: 1.05,
      })
      return { file: rendered.file, durationSec: rendered.durationSec, transitionOut: null }
    })

    await assertRunOwner(project.id, runToken)
    setProgress(45)

    if (bgFile && fs.existsSync(bgFile)) {
      // Step A: Concat image slideshow
      await concatClips(slices, rawSlideshow, { transitionDuration: 0 })

      // Step B: Render background layer video
      const bgVideo = path.join(tmp, 'bg_layer.mp4')
      await applyMotionImage({
        src: bgFile,
        out: bgVideo,
        durationSec: totalDuration,
        width,
        height,
        zoomMax: 1.02,
      })

      // Step C: Multi-layer Composite: Background on layer 0, Slideshow on layer 1
      await ffmpeg([
        '-y',
        '-i', bgVideo,
        '-i', rawSlideshow,
        '-filter_complex', '[0:v][1:v]overlay=(W-w)/2:(H-h)/2:shortest=1[v]',
        '-map', '[v]',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        concatFile,
      ])
    } else {
      await concatClips(slices, concatFile, { transitionDuration: 0 })
    }
  } else if (bgFile && fs.existsSync(bgFile)) {
    // Only background, no images
    await applyMotionImage({
      src: bgFile,
      out: concatFile,
      durationSec: totalDuration,
      width,
      height,
      zoomMax: 1.02,
    })
  } else {
    // Fallback: generate solid background video
    await ffmpeg([
      '-y', '-f', 'lavfi',
      '-i', `color=c=${defaultBgColor}:s=${width}x${height}:d=${round2(totalDuration)}:r=30`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      concatFile,
    ])
  }

  await assertRunOwner(project.id, runToken)
  setProgress(65)

  // 2. Build Audio Track (Voiceover + Music with Ducking & Looping)
  const voiceClips = clips.filter((c) => c.clip_type === 'voiceover' || c.voice_audio_id || c.audio_id)
  const voiceEntries = []
  for (const vc of voiceClips) {
    const audioId = vc.audio_id || vc.voice_audio_id
    const aud = audioById.get(audioId)
    const prepWav = path.join(prepDir, `voice_${vc.id}.wav`)
    const absAudio = fs.existsSync(prepWav) ? prepWav : (aud ? resolveStorageKey(aud.storage_key) : null)
    if (absAudio && fs.existsSync(absAudio)) {
      voiceEntries.push({
        file: absAudio,
        offsetSec: Number(vc.start_at_sec) || 0,
      })
    }
  }

  const voiceTrack = path.join(tmp, 'voice.wav')
  if (voiceEntries.length > 0) {
    await buildVoiceTrack(voiceEntries, totalDuration + 0.5, voiceTrack)
  } else {
    // Generate silent voice track
    await ffmpeg([
      '-y', '-f', 'lavfi',
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-t', String(totalDuration + 0.5),
      '-c:a', 'pcm_s16le',
      voiceTrack,
    ])
  }

  // Find BGM Music
  const musicClips = clips.filter((c) => c.clip_type === 'music')
  let musicFile = null
  let targetBgmVolume = 0.35
  let isDuckingEnabled = true
  if (musicClips.length > 0) {
    const mc = musicClips[0]
    targetBgmVolume = Number(mc.volume ?? 0.35)
    if (mc.meta) {
      try {
        const parsedMeta = typeof mc.meta === 'string' ? JSON.parse(mc.meta) : mc.meta
        if (parsedMeta.ducking === false) isDuckingEnabled = false
      } catch (_) {}
    }
    const asset = assetById.get(mc.asset_id) || audioById.get(mc.audio_id)
    if (asset) {
      const abs = resolveStorageKey(asset.storage_key)
      if (abs && fs.existsSync(abs)) {
        musicFile = abs
      }
    }
  }

  setProgress(75)
  await assertRunOwner(project.id, runToken)

  const mixed = path.join(tmp, 'mixed.mp4')
  const hasVoice = voiceEntries.length > 0 && fs.existsSync(voiceTrack)
  const hasMusic = Boolean(musicFile && fs.existsSync(musicFile))
  const roundDuration = Math.max(0.5, round2(totalDuration))
  const tail = `apad,atrim=0:${roundDuration},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]`

  if (hasVoice && hasMusic) {
    let audioFilter
    if (isDuckingEnabled) {
      // Loop music indefinitely, then sidechaincompress to dip -12dB under speech
      audioFilter =
        `[2:a]aresample=48000,aloop=loop=-1:size=2e+09,atrim=0:${roundDuration}[bgm_loop];` +
        `[1:a]aresample=48000[voice];` +
        `[bgm_loop][voice]sidechaincompress=threshold=0.03:ratio=6:attack=50:release=300:volume=${targetBgmVolume}[bgm_ducked];` +
        `[voice][bgm_ducked]amix=inputs=2:duration=first:normalize=0,${tail}`
    } else {
      audioFilter =
        `[2:a]aresample=48000,aloop=loop=-1:size=2e+09,atrim=0:${roundDuration},volume=${targetBgmVolume}[bgm];` +
        `[1:a]aresample=48000[voice];` +
        `[voice][bgm]amix=inputs=2:duration=first:normalize=0,${tail}`
    }
    await ffmpeg([
      '-y',
      '-i', concatFile,
      '-i', voiceTrack,
      '-i', musicFile,
      '-filter_complex', audioFilter,
      '-map', '0:v',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      mixed,
    ])
  } else if (hasMusic) {
    const audioFilter = `[1:a]aresample=48000,aloop=loop=-1:size=2e+09,atrim=0:${roundDuration},volume=${targetBgmVolume},${tail}`
    await ffmpeg([
      '-y',
      '-i', concatFile,
      '-i', musicFile,
      '-filter_complex', audioFilter,
      '-map', '0:v',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      mixed,
    ])
  } else if (hasVoice) {
    const audioFilter = `[1:a]${tail}`
    await ffmpeg([
      '-y',
      '-i', concatFile,
      '-i', voiceTrack,
      '-filter_complex', audioFilter,
      '-map', '0:v',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      mixed,
    ])
  } else {
    // No voice, no music: add silent audio track
    await ffmpeg([
      '-y',
      '-i', concatFile,
      '-f', 'lavfi',
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-t', String(roundDuration),
      '-movflags', '+faststart',
      mixed,
    ])
  }

  setProgress(85)
  await assertRunOwner(project.id, runToken)

  // 3. Burn Text Overlays
  const assRow = await query(
    `SELECT storage_key FROM subtitles WHERE project_id = ? AND format = 'ass' ORDER BY rowid DESC LIMIT 1`,
    [project.id]
  )
  const assAbs = assRow[0] ? resolveStorageKey(assRow[0].storage_key) : path.join(prepDir, 'subtitles.ass')
  const burnSubtitles = Boolean(assAbs && fs.existsSync(assAbs) && fs.statSync(assAbs).size > 200)

  const outId = uuidv4()
  const outputsAbs = ensureDir(path.join(config.storageDir, 'outputs'))
  const finalPath = path.join(outputsAbs, `${outId}.mp4`)

  if (burnSubtitles) {
    try {
      await burnSubtitlesStyled(mixed, assAbs, finalPath)
    } catch (burnErr) {
      console.warn(`[composerRender] Subtitle burn failed, using raw mixed video: ${burnErr.message}`)
      fs.copyFileSync(mixed, finalPath)
    }
  } else {
    fs.copyFileSync(mixed, finalPath)
  }

  setProgress(92)
  await assertRunOwner(project.id, runToken)

  // 4. Validate output
  const info = await probe(finalPath)
  const byteSize = fs.existsSync(finalPath) ? fs.statSync(finalPath).size : 0
  if (!(info.durationSec > 0.2) || !(info.width > 0) || !(info.height > 0) || !(byteSize > 0)) {
    try { fs.unlinkSync(finalPath) } catch (_) {}
    throw new Error(`COMPOSER_RENDER_INVALID: file render không hợp lệ (duration=${info.durationSec}, ${info.width}x${info.height}, bytes=${byteSize})`)
  }

  // 5. Generate thumbnail
  const thumbsAbs = ensureDir(path.join(outputsAbs, 'thumbs'))
  const thumbRel = `outputs/thumbs/${outId}.jpg`
  try {
    await makeThumbnail(finalPath, Math.min(2, info.durationSec / 2), path.join(thumbsAbs, `${outId}.jpg`))
  } catch (err) {
    console.warn(`[composerRender] makeThumbnail failed: ${err.message}`)
  }

  // 6. Record in outputs table
  await assertRunOwner(project.id, runToken)
  await createOutput({
    id: outId,
    projectId: project.id,
    storageKey: `outputs/${outId}.mp4`,
    status: 'success',
    durationSec: round2(info.durationSec),
    thumbnailKey: thumbRel,
    runToken,
  })

  setProgress(100)
  return {
    outputId: outId,
    storageKey: `outputs/${outId}.mp4`,
    durationSec: round2(info.durationSec),
    width: info.width,
    height: info.height,
  }
}

export default composerRender
