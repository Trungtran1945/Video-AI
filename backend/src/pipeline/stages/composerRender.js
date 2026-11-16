import fs from 'node:fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { query } from '../../db/query.js'
import {
  applyMotionImage,
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

  const tracks = await query(
    'SELECT * FROM timeline_tracks WHERE project_id = ? ORDER BY order_index ASC',
    [project.id]
  )
  const trackByType = new Map(tracks.map((t) => [t.track_type, t]))

  const assets = await query('SELECT * FROM assets WHERE project_id = ?', [project.id])
  const assetById = new Map(assets.map((a) => [a.id, a]))

  const audios = await query('SELECT * FROM audios WHERE project_id = ?', [project.id])
  const audioById = new Map(audios.map((a) => [a.id, a]))

  const tmp = ensureDir(tmpDirOf(project.id))
  const segDir = ensureDir(path.join(tmp, 'segments'))
  const prepDir = ensureDir(path.join(tmp, 'prepared'))
  const { width, height } = dimsForAspect(project.aspect_ratio || '16:9')

  // Calculate total duration from timeline clips
  let maxEnd = 0
  for (const c of clips) {
    const end = (Number(c.start_at_sec) || 0) + Math.max(0, Number(c.out_sec) - Number(c.in_sec || 0))
    if (end > maxEnd) maxEnd = end
  }
  const totalDuration = round2(Math.max(1, maxEnd))

  // 1. Build Background Layer Video (Respect Video Background vs Image Background vs Solid Color)
  const bgClips = clips.filter((c) => c.clip_type === 'background')
  const bgAsset = bgClips[0] ? assetById.get(bgClips[0].asset_id) : null
  const bgFile = bgAsset ? resolveStorageKey(bgAsset.storage_key) : null
  const defaultBgColor = project?.params?.defaultBackground || '#0F1117'
  const bgVideoPath = path.join(tmp, 'bg_layer.mp4')
  let bgAudioFile = null

  if (bgFile && fs.existsSync(bgFile)) {
    let isVideoBg = false
    let bgDuration = 0
    let bgInfo = null
    try {
      bgInfo = await probe(bgFile)
      bgDuration = bgInfo.durationSec || 0
      const ext = path.extname(bgFile).toLowerCase()
      if (
        ['.mp4', '.webm', '.mov', '.mkv', '.m4v'].includes(ext) ||
        bgAsset?.mime_type?.startsWith('video/')
      ) {
        isVideoBg = true
      }
    } catch (_) {}

    if (isVideoBg) {
      let bgMeta = {}
      try {
        if (typeof bgClips[0]?.meta === 'string') {
          bgMeta = JSON.parse(bgClips[0].meta)
        } else if (bgClips[0]?.meta && typeof bgClips[0].meta === 'object') {
          bgMeta = bgClips[0].meta
        }
      } catch (_) {}

      const fitMode = bgMeta.fit || 'cover'
      const shouldLoop = bgMeta.loop !== false
      const loopArg = shouldLoop && bgDuration > 0 && bgDuration < totalDuration ? ['-stream_loop', '-1'] : []
      const padColor = (defaultBgColor || '#0F1117').startsWith('#')
        ? defaultBgColor.replace(/^#/, '0x')
        : (defaultBgColor || '0x0F1117')
      const vfFilter = fitMode === 'contain'
        ? `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${padColor},setsar=1`
        : `scale=w=${width}:h=${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`

      // Video Background: Loop or trim, preserve video frames, fit canvas aspect ratio
      await ffmpeg([
        '-y',
        ...loopArg,
        '-i', bgFile,
        '-t', String(totalDuration),
        '-vf', vfFilter,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-an',
        bgVideoPath,
      ])

      // If user enabled audio on video background (muted === false) and source has audio
      if (bgMeta.muted === false && bgInfo?.hasAudio) {
        const candidateAudio = path.join(tmp, 'bg_audio.wav')
        const bgVol = Number.isFinite(Number(bgMeta.volume)) ? Number(bgMeta.volume) : 1.0
        try {
          await ffmpeg([
            '-y',
            ...(shouldLoop && bgDuration > 0 && bgDuration < totalDuration ? ['-stream_loop', '-1'] : []),
            '-i', bgFile,
            '-t', String(totalDuration),
            '-vn',
            '-af', `volume=${Math.max(0, Math.min(2.0, bgVol))}`,
            '-c:a', 'pcm_s16le',
            candidateAudio,
          ])
          if (fs.existsSync(candidateAudio)) {
            bgAudioFile = candidateAudio
          }
        } catch (_) {
          bgAudioFile = null
        }
      }
    } else {
      // Image Background: Apply subtle cinematic motion across total duration
      await applyMotionImage({
        src: bgFile,
        out: bgVideoPath,
        durationSec: totalDuration,
        width,
        height,
        zoomMax: 1.02,
      })
    }
  } else {
    // Solid background fallback
    const solidColor = (defaultBgColor || '#0F1117').startsWith('#')
      ? defaultBgColor.replace(/^#/, '0x')
      : (defaultBgColor || '0x0F1117')
    await ffmpeg([
      '-y', '-f', 'lavfi',
      '-i', `color=c=${solidColor}:s=${width}x${height}:d=${round2(totalDuration)}:r=30`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      bgVideoPath,
    ])
  }

  // 2. Build Visual Track (Timeline Absolute Positioning for Image & Video Clips)
  const imageClips = clips.filter((c) => c.clip_type === 'image' || c.clip_type === 'video' || (!c.clip_type && c.source_type === 'ASSET'))
  let visualTrackFile = bgVideoPath
  const videoAudioEntries = []

  if (imageClips.length > 0) {
    setProgress(15)
    const slices = await mapWithConcurrency(imageClips, 2, async (clip, idx) => {
      if (signal?.aborted) throw new Error('Cancelled')
      const prepImg = path.join(prepDir, `img_${clip.id}.png`)
      const asset = assetById.get(clip.asset_id)
      const srcImg = fs.existsSync(prepImg) ? prepImg : (asset ? resolveStorageKey(asset.storage_key) : null)
      if (!srcImg || !fs.existsSync(srcImg)) {
        throw new Error(`File phương tiện cho clip #${clip.order_index} không tồn tại`)
      }

      let clipMeta = {}
      try {
        if (typeof clip.meta === 'string') clipMeta = JSON.parse(clip.meta)
        else if (clip.meta && typeof clip.meta === 'object') clipMeta = clip.meta
      } catch (_) {}

      const fitMode = clipMeta.fit || 'contain'
      const inSec = Math.max(0, Number(clip.in_sec || 0))
      const rawDur = Math.max(0.5, Number(clip.out_sec) - inSec)
      const rawSpeed = Number(clip.speed)
      const speed = Number.isFinite(rawSpeed) && rawSpeed > 0 ? Math.min(10, Math.max(0.1, rawSpeed)) : 1.0
      const durationSec = speed !== 1.0 ? rawDur / speed : rawDur
      const startAt = Math.max(0, Number(clip.start_at_sec) || 0)
      const out = path.join(segDir, `seg_${String(idx).padStart(3, '0')}.mp4`)

      let rendered
      const isVid = clip.clip_type === 'video' || asset?.mime_type?.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/i.test(srcImg)
      if (isVid) {
        let vf = fitMode === 'cover'
          ? `scale=w=${width}:h=${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
          : `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease`
        if (speed !== 1.0) {
          vf = `setpts=${(1 / speed).toFixed(6)}*PTS,` + vf
        }

        await ffmpeg([
          '-y',
          '-ss', String(inSec),
          '-i', srcImg,
          '-t', String(rawDur),
          '-vf', vf,
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-pix_fmt', 'yuv420p',
          '-an',
          out,
        ])
        rendered = { file: out, durationSec }

        // Audio extraction for video clip if track not muted
        const vidTrack = trackByType.get('video')
        const isVidTrackMuted = vidTrack ? Boolean(vidTrack.muted) : false
        const vidTrackVol = vidTrack && Number.isFinite(Number(vidTrack.volume))
          ? Math.max(0, Math.min(2.0, Number(vidTrack.volume)))
          : 1.0

        if (!isVidTrackMuted && vidTrackVol > 0) {
          try {
            const probeInfo = await probe(srcImg)
            if (probeInfo.hasAudio) {
              const vidAudioOut = path.join(segDir, `vid_audio_${String(idx).padStart(3, '0')}.wav`)
              const clipVol = Number.isFinite(Number(clip.volume)) ? Number(clip.volume) : 1.0
              const effVol = Math.max(0, Math.min(2.0, clipVol * vidTrackVol))
              const af = []
              if (speed !== 1.0) {
                let s = speed
                while (s > 2.0) { af.push('atempo=2.0'); s /= 2.0 }
                while (s < 0.5) { af.push('atempo=0.5'); s /= 0.5 }
                af.push(`atempo=${s.toFixed(4)}`)
              }
              af.push(`volume=${effVol.toFixed(3)}`)
              af.push('aresample=48000')

              await ffmpeg([
                '-y',
                '-ss', String(inSec),
                '-i', srcImg,
                '-t', String(rawDur),
                '-vn',
                '-af', af.join(','),
                '-c:a', 'pcm_s16le',
                vidAudioOut,
              ])
              if (fs.existsSync(vidAudioOut)) {
                videoAudioEntries.push({
                  file: vidAudioOut,
                  offsetSec: startAt,
                  volume: 1.0,
                })
              }
            }
          } catch (e) {
            console.warn(`[composerRender] Extract video audio failed for clip ${clip.id}:`, e.message)
          }
        }
      } else {
        if (fitMode === 'cover' || clipMeta.motion === true) {
          rendered = await applyMotionImage({
            src: srcImg,
            out,
            durationSec,
            width,
            height,
            zoomMax: 1.05,
          })
        } else {
          // Static contained image preserving canvas background visibility
          await ffmpeg([
            '-y',
            '-loop', '1',
            '-t', String(durationSec),
            '-i', srcImg,
            '-vf', `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease`,
            '-r', '30',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-pix_fmt', 'yuv420p',
            '-an',
            out,
          ])
          rendered = { file: out, durationSec }
        }
      }
      return {
        file: rendered.file,
        durationSec: rendered.durationSec,
        startAt,
        endAt: round2(startAt + rendered.durationSec),
      }
    })

    await assertRunOwner(project.id, runToken)
    setProgress(50)

    // Multi-layer Composite: Background on layer 0, Image segments time-shifted and overlaid at exact timeline start_at_sec
    const compositeFile = path.join(tmp, 'visual_composite.mp4')
    const inputs = ['-y', '-i', bgVideoPath]
    for (const slice of slices) {
      inputs.push('-i', slice.file)
    }

    const filterLines = []
    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i]
      const inputIdx = i + 1
      filterLines.push(`[${inputIdx}:v]setpts=PTS-STARTPTS+${slice.startAt}/TB[v${inputIdx}_timed]`)
    }

    let prevLayer = '0:v'
    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i]
      const inputIdx = i + 1
      const nextLayer = i === slices.length - 1 ? 'v_comp' : `l_${inputIdx}`
      filterLines.push(
        `[${prevLayer}][v${inputIdx}_timed]overlay=(W-w)/2:(H-h)/2:enable='between(t,${slice.startAt},${slice.endAt})':eof_action=pass[${nextLayer}]`
      )
      prevLayer = nextLayer
    }

    await ffmpeg([
      ...inputs,
      '-filter_complex', filterLines.join(';'),
      '-map', '[v_comp]',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      compositeFile,
    ])

    visualTrackFile = compositeFile
  }

  await assertRunOwner(project.id, runToken)
  setProgress(65)

  // 3. Build Audio Track (Voiceover + SFX + Music respecting Track Mute, Track Volume & Ducking)
  const voiceTrackConfig = trackByType.get('voiceover')
  const isVoiceMuted = voiceTrackConfig ? Boolean(voiceTrackConfig.muted) : false
  const voiceTrackVolume = voiceTrackConfig && Number.isFinite(Number(voiceTrackConfig.volume))
    ? Math.max(0, Math.min(2.0, Number(voiceTrackConfig.volume)))
    : 1.0

  const voiceClips = clips.filter((c) => c.clip_type === 'voiceover' || (!c.clip_type && (c.voice_audio_id || c.audio_id)))
  const voiceEntries = []

  if (!isVoiceMuted && voiceTrackVolume > 0) {
    for (const vc of voiceClips) {
      const audioId = vc.audio_id || vc.voice_audio_id || vc.asset_id
      const aud = audioById.get(audioId) || assetById.get(audioId)
      const prepWav = path.join(prepDir, `voice_${vc.id}.wav`)
      const absAudio = fs.existsSync(prepWav) ? prepWav : (aud ? resolveStorageKey(aud.storage_key) : null)
      if (absAudio && fs.existsSync(absAudio)) {
        const clipVol = Number.isFinite(Number(vc.volume)) ? Number(vc.volume) : 1.0
        const effectiveVol = Math.max(0, Math.min(2.0, clipVol * voiceTrackVolume))
        voiceEntries.push({
          file: absAudio,
          offsetSec: Number(vc.start_at_sec) || 0,
          volume: effectiveVol,
        })
      }
    }
  }

  // SFX track support (including extracted video audio)
  const sfxTrackConfig = trackByType.get('sfx')
  const isSfxMuted = sfxTrackConfig ? Boolean(sfxTrackConfig.muted) : false
  const sfxTrackVolume = sfxTrackConfig && Number.isFinite(Number(sfxTrackConfig.volume))
    ? Math.max(0, Math.min(2.0, Number(sfxTrackConfig.volume)))
    : 1.0

  const sfxClips = clips.filter((c) => c.clip_type === 'sfx')
  const sfxEntries = [...videoAudioEntries]

  if (!isSfxMuted && sfxTrackVolume > 0) {
    for (const sc of sfxClips) {
      const audioId = sc.audio_id || sc.voice_audio_id || sc.asset_id
      const aud = audioById.get(audioId) || assetById.get(audioId)
      const prepWav = path.join(prepDir, `voice_${sc.id}.wav`)
      const absAudio = fs.existsSync(prepWav) ? prepWav : (aud ? resolveStorageKey(aud.storage_key) : null)
      if (absAudio && fs.existsSync(absAudio)) {
        const clipVol = Number.isFinite(Number(sc.volume)) ? Number(sc.volume) : 1.0
        const effectiveVol = Math.max(0, Math.min(2.0, clipVol * sfxTrackVolume))
        sfxEntries.push({
          file: absAudio,
          offsetSec: Number(sc.start_at_sec) || 0,
          volume: effectiveVol,
        })
      }
    }
  }

  const voiceTrack = path.join(tmp, 'voice.wav')
  const hasVoice = voiceEntries.length > 0
  if (hasVoice) {
    await buildVoiceTrack(voiceEntries, totalDuration + 0.5, voiceTrack)
  }

  const sfxTrack = path.join(tmp, 'sfx.wav')
  const hasSfx = sfxEntries.length > 0
  if (hasSfx) {
    const sfxInputs = []
    for (const e of sfxEntries) sfxInputs.push('-i', e.file)
    const sfxFilters = []
    const sfxLabels = []
    sfxEntries.forEach((e, i) => {
      const delayMs = Math.max(0, Math.round((e.offsetSec || 0) * 1000))
      const vol = Number.isFinite(e.volume) ? e.volume : 1.0
      sfxFilters.push(`[${i}:a]aresample=48000,volume=${vol},adelay=${delayMs}:all=1[s${i}]`)
      sfxLabels.push(`[s${i}]`)
    })
    if (sfxEntries.length > 1) {
      sfxFilters.push(`${sfxLabels.join('')}amix=inputs=${sfxEntries.length}:duration=longest:normalize=0,apad,atrim=0:${round2(totalDuration)},aresample=48000[out]`)
    } else {
      sfxFilters.push(`${sfxLabels[0]}apad,atrim=0:${round2(totalDuration)},aresample=48000[out]`)
    }
    await ffmpeg([
      '-y',
      ...sfxInputs,
      '-filter_complex', sfxFilters.join(';'),
      '-map', '[out]',
      '-ac', '2', '-ar', '48000',
      '-c:a', 'pcm_s16le',
      sfxTrack,
    ])
  }

  // Find BGM Music (Respect track mute, track volume, multiple clips with timing offsets)
  const musicTrackConfig = trackByType.get('music')
  const isMusicMuted = musicTrackConfig ? Boolean(musicTrackConfig.muted) : false
  const musicTrackVolume = musicTrackConfig && Number.isFinite(Number(musicTrackConfig.volume))
    ? Math.max(0, Math.min(2.0, Number(musicTrackConfig.volume)))
    : 1.0

  const musicClips = clips.filter((c) => c.clip_type === 'music')
  const musicEntries = []
  let isDuckingEnabled = true

  if (!isMusicMuted && musicTrackVolume > 0 && musicClips.length > 0) {
    for (const mc of musicClips) {
      const clipVol = Number.isFinite(Number(mc.volume)) ? Number(mc.volume) : 0.8
      const effectiveVol = Math.max(0, Math.min(2.0, clipVol * musicTrackVolume))
      let clipMeta = {}
      try {
        if (typeof mc.meta === 'string') clipMeta = JSON.parse(mc.meta)
        else if (mc.meta && typeof mc.meta === 'object') clipMeta = mc.meta
      } catch (_) {}
      if (clipMeta.ducking === false) isDuckingEnabled = false

      const asset = assetById.get(mc.asset_id) || audioById.get(mc.voice_audio_id) || audioById.get(mc.audio_id)
      if (asset) {
        const abs = resolveStorageKey(asset.storage_key)
        if (abs && fs.existsSync(abs)) {
          const inSec = Math.max(0, Number(mc.in_sec || 0))
          const dur = Math.max(0.5, Number(mc.out_sec) - inSec)
          musicEntries.push({
            file: abs,
            offsetSec: Math.max(0, Number(mc.start_at_sec) || 0),
            durationSec: dur,
            volume: effectiveVol,
            loop: clipMeta.loop !== false,
          })
        }
      }
    }
  } else if (bgAudioFile && fs.existsSync(bgAudioFile)) {
    musicEntries.push({
      file: bgAudioFile,
      offsetSec: 0,
      durationSec: totalDuration,
      volume: 1.0,
      loop: false,
    })
  }

  const musicTrack = path.join(tmp, 'music.wav')
  const hasMusic = musicEntries.length > 0
  if (hasMusic) {
    const musInputs = []
    for (const e of musicEntries) musInputs.push('-i', e.file)
    const musFilters = []
    const musLabels = []
    musicEntries.forEach((e, i) => {
      const delayMs = Math.max(0, Math.round((e.offsetSec || 0) * 1000))
      const vol = Number.isFinite(e.volume) ? e.volume : 0.8
      const dur = e.durationSec ? Math.max(0.5, e.durationSec) : (totalDuration - (e.offsetSec || 0))
      const loopPart = e.loop ? `aloop=loop=-1:size=2e+09,atrim=0:${round2(dur)},` : `atrim=0:${round2(dur)},`
      musFilters.push(`[${i}:a]aresample=48000,${loopPart}volume=${vol},adelay=${delayMs}:all=1[m${i}]`)
      musLabels.push(`[m${i}]`)
    })
    if (musicEntries.length > 1) {
      musFilters.push(`${musLabels.join('')}amix=inputs=${musicEntries.length}:duration=longest:normalize=0,apad,atrim=0:${round2(totalDuration)},aresample=48000[out]`)
    } else {
      musFilters.push(`${musLabels[0]}apad,atrim=0:${round2(totalDuration)},aresample=48000[out]`)
    }
    await ffmpeg([
      '-y',
      ...musInputs,
      '-filter_complex', musFilters.join(';'),
      '-map', '[out]',
      '-ac', '2', '-ar', '48000',
      '-c:a', 'pcm_s16le',
      musicTrack,
    ])
  }

  setProgress(75)
  await assertRunOwner(project.id, runToken)

  const mixed = path.join(tmp, 'mixed.mp4')
  const roundDuration = Math.max(0.5, round2(totalDuration))
  const tail = `apad,atrim=0:${roundDuration},aresample=48000[aout]`

  const inputs = ['-y', '-i', visualTrackFile]
  let voiceIdx = -1
  let musicIdx = -1
  let sfxIdx = -1
  let nextInputIdx = 1

  if (hasVoice && fs.existsSync(voiceTrack)) {
    inputs.push('-i', voiceTrack)
    voiceIdx = nextInputIdx++
  }
  if (hasMusic && fs.existsSync(musicTrack)) {
    inputs.push('-i', musicTrack)
    musicIdx = nextInputIdx++
  }
  if (hasSfx && fs.existsSync(sfxTrack)) {
    inputs.push('-i', sfxTrack)
    sfxIdx = nextInputIdx++
  }

  let audioFilter = ''
  if (voiceIdx !== -1 && musicIdx !== -1) {
    if (isDuckingEnabled) {
      audioFilter += `[${voiceIdx}:a]aresample=48000,asplit=2[v_side][v_mix];`
      audioFilter += `[${musicIdx}:a][v_side]sidechaincompress=threshold=0.03:ratio=6:attack=50:release=300[ducked_bgm];`
      audioFilter += `[v_mix][ducked_bgm]amix=inputs=2:duration=first:normalize=0[vm_mix];`
    } else {
      audioFilter += `[${voiceIdx}:a][${musicIdx}:a]amix=inputs=2:duration=first:normalize=0[vm_mix];`
    }
    if (sfxIdx !== -1) {
      audioFilter += `[vm_mix][${sfxIdx}:a]amix=inputs=2:duration=first:normalize=0,${tail}`
    } else {
      audioFilter += `[vm_mix]${tail}`
    }
  } else if (voiceIdx !== -1) {
    if (sfxIdx !== -1) {
      audioFilter += `[${voiceIdx}:a][${sfxIdx}:a]amix=inputs=2:duration=first:normalize=0,${tail}`
    } else {
      audioFilter += `[${voiceIdx}:a]${tail}`
    }
  } else if (musicIdx !== -1) {
    if (sfxIdx !== -1) {
      audioFilter += `[${musicIdx}:a][${sfxIdx}:a]amix=inputs=2:duration=first:normalize=0,${tail}`
    } else {
      audioFilter += `[${musicIdx}:a]${tail}`
    }
  } else if (sfxIdx !== -1) {
    audioFilter += `[${sfxIdx}:a]${tail}`
  }

  if (audioFilter) {
    await ffmpeg([
      ...inputs,
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
    // No voice, no music, no sfx: add silent audio track
    await ffmpeg([
      '-y',
      '-i', visualTrackFile,
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

  // 4. Burn Text Overlays (Strict: Do not burn if 0 text clips, throw on burn failure)
  const assRow = await query(
    `SELECT storage_key FROM subtitles WHERE project_id = ? AND format = 'ass' ORDER BY rowid DESC LIMIT 1`,
    [project.id]
  )
  const assAbs = assRow[0] ? resolveStorageKey(assRow[0].storage_key) : path.join(prepDir, 'subtitles.ass')
  const textClips = clips.filter((c) => c.clip_type === 'text' || Boolean(c.text_content))
  const burnSubtitles = Boolean(textClips.length > 0 && assAbs && fs.existsSync(assAbs) && fs.statSync(assAbs).size > 200)

  const outId = uuidv4()
  const outputsAbs = ensureDir(path.join(config.storageDir, 'outputs'))
  const finalPath = path.join(outputsAbs, `${outId}.mp4`)

  if (burnSubtitles) {
    try {
      await burnSubtitlesStyled(mixed, assAbs, finalPath)
    } catch (burnErr) {
      console.error(`[composerRender] Subtitle burn failed: ${burnErr.message}`)
      const err = new Error(`Lỗi kết xuất phụ đề văn bản: ${burnErr.message}`)
      err.code = 'COMPOSER_SUBTITLE_RENDER_FAILED'
      throw err
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
