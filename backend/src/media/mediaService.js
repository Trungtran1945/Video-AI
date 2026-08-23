import path from 'path'
import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { ffmpeg, probe } from './ffmpeg.js'

export { probe }

const round2 = (n) => Math.round(n * 100) / 100
const round3 = (n) => Math.round(n * 1000) / 1000

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

async function durationOf(file) {
  const info = await probe(file)
  return info.durationSec
}

export async function extractAudio(src, out) {
  ensureDir(out)
  await ffmpeg(['-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', out])
  return out
}

export async function sliceAudio(src, out, startSec, durSec) {
  ensureDir(out)
  await ffmpeg([
    '-y', '-ss', String(startSec), '-i', src, '-t', String(durSec),
    '-vn', '-ac', '1', '-ar', '16000', out,
  ])
  return out
}

export async function detectScenes(src, { threshold = 0.4, minSceneSec = 2 } = {}) {
  const info = await probe(src)
  if (!info.durationSec) return []
  const { stderr } = await ffmpeg([
    '-y', '-i', src,
    '-vf', `select='gt(scene,${threshold})',showinfo`,
    '-an', '-f', 'null', '-',
  ])
  const cuts = []
  const re = /pts_time:([0-9]+(?:\.[0-9]+)?)/g
  let match
  while ((match = re.exec(stderr)) !== null) {
    const t = parseFloat(match[1])
    if (t > 0.5 && t < info.durationSec - 0.5 && (cuts.length === 0 || t - cuts[cuts.length - 1] >= minSceneSec * 0.5)) {
      cuts.push(t)
    }
  }
  const bounds = [0, ...cuts, info.durationSec]
  const scenes = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]
    const end = bounds[i + 1]
    if (end - start >= minSceneSec) {
      scenes.push({ startSec: round2(start), endSec: round2(end) })
    }
  }
  if (scenes.length === 0 && info.durationSec >= minSceneSec) {
    scenes.push({ startSec: 0, endSec: round2(info.durationSec) })
  }
  for (let i = 0; i < scenes.length; i++) {
    if (i < scenes.length - 1) scenes[i].endSec = scenes[i + 1].startSec
  }
  return scenes
}

export async function makeThumbnail(src, atSec, out) {
  ensureDir(out)
  await ffmpeg(['-y', '-ss', String(Math.max(0, atSec)), '-i', src, '-frames:v', '1', '-q:v', '3', out])
  return out
}

export async function transcodeToMezzanine(src, out, { withAudio = false } = {}) {
  ensureDir(out)
  const args = [
    '-y', '-i', src,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1',
    '-r', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
  ]
  if (withAudio) args.push('-c:a', 'aac', '-b:a', '128k')
  else args.push('-an')
  args.push('-movflags', '+faststart', out)
  await ffmpeg(args)
  return out
}

export async function clipSlice({ src, inSec, outSec, speed = 1, out }) {
  ensureDir(out)
  const rawDur = Math.max(0.1, outSec - inSec)
  const targetDur = rawDur / speed
  await ffmpeg([
    '-y', '-ss', String(inSec), '-i', src, '-t', String(round3(targetDur)),
    '-vf', `setpts=${(1 / speed).toFixed(6)}*PTS,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1`,
    '-an', '-r', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    out,
  ])
  return { file: out, durationSec: round3(await durationOf(out)) }
}

const XFADE_MAP = {
  cross: 'fade',
  fade: 'fade',
  slide: 'slideleft',
  wipe: 'wipeleft',
}

export async function concatClips(clips, out, { transitionDuration = 0.3 } = {}) {
  ensureDir(out)
  if (!clips.length) throw new Error('Không có clip nào để ghép')
  if (clips.length === 1) {
    await ffmpeg(['-y', '-i', clips[0].file, '-c', 'copy', '-movflags', '+faststart', out])
    return out
  }
  const hasTransition = clips.some((c, i) => i < clips.length - 1 && c.transitionOut)
  if (!hasTransition) {
    const tmpList = path.join(path.dirname(out), `concat_${uuidv4()}.txt`)
    const body = clips.map((c) => `file '${c.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n')
    fs.writeFileSync(tmpList, body + '\n')
    try {
      await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', tmpList, '-c', 'copy', '-movflags', '+faststart', out])
    } finally {
      try { fs.unlinkSync(tmpList) } catch (_) {}
    }
    return out
  }

  const inputs = []
  for (const c of clips) inputs.push('-i', c.file)
  const parts = []
  let prevLabel = '[0:v]'
  let running = clips[0].durationSec
  for (let i = 1; i < clips.length; i++) {
    const name = XFADE_MAP[clips[i - 1].transitionOut] || 'fade'
    const tDur = transitionDuration
    const offset = Math.max(0, round3(running - tDur))
    const label = `[v${i}]`
    parts.push(`${prevLabel}[${i}:v]xfade=transition=${name}:duration=${tDur}:offset=${offset}${label}`)
    prevLabel = label
    running = offset + clips[i].durationSec
  }
  await ffmpeg([
    ...inputs,
    '-filter_complex', parts.join(';'),
    '-map', `[v${clips.length - 1}]`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    out,
  ])
  return out
}

export async function buildVoiceTrack(entries, totalSec, out) {
  ensureDir(out)
  if (!entries.length) throw new Error('Không có âm thanh giọng đọc để dựng track')
  const inputs = []
  for (const e of entries) inputs.push('-i', e.file)
  const filters = []
  const labels = []
  entries.forEach((e, i) => {
    const delayMs = Math.max(0, Math.round((e.offsetSec || 0) * 1000))
    filters.push(`[${i}:a]aresample=48000,adelay=${delayMs}:all=1[a${i}]`)
    labels.push(`[a${i}]`)
  })
  filters.push(`${labels.join('')}amix=inputs=${entries.length}:duration=longest:normalize=0,apad,atrim=0:${round3(totalSec)},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[out]`)
  await ffmpeg([
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[out]',
    '-ac', '2', '-ar', '48000',
    '-c:a', 'pcm_s16le',
    out,
  ])
  return out
}

export async function mixAudio(videoFile, voiceFile, musicFile, out, { videoDurationSec } = {}) {
  ensureDir(out)
  const duration = videoDurationSec || (await probe(videoFile)).durationSec
  const tail = `apad,atrim=0:${round3(duration)},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]`
  let args
  let filter
  if (musicFile) {
    filter = `[1:a]aresample=48000[v];[2:a]aresample=48000,volume=0.25[m];[m][v]amix=inputs=2:duration=longest:normalize=0,${tail}`
    args = ['-i', videoFile, '-i', voiceFile, '-i', musicFile]
  } else {
    filter = `[1:a]${tail}`
    args = ['-i', videoFile, '-i', voiceFile]
  }
  await ffmpeg([
    ...args,
    '-filter_complex', filter,
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-shortest', '-movflags', '+faststart',
    out,
  ])
  return out
}

export async function addSubtitles(inFile, srtPath, out) {
  ensureDir(out)
  const cwd = path.dirname(srtPath)
  const base = path.basename(srtPath)
  await ffmpeg(
    [
      '-y', '-i', inFile,
      '-vf', `subtitles=${base}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      out,
    ],
    { cwd }
  )
  return out
}

export async function applyGrade(inFile, out, grade = {}) {
  ensureDir(out)
  const contrast = Number.isFinite(grade.contrast) ? grade.contrast : 1.05
  const saturation = Number.isFinite(grade.saturation) ? grade.saturation : 1.08
  const brightness = Number.isFinite(grade.brightness) ? grade.brightness : 0
  await ffmpeg([
    '-y', '-i', inFile,
    '-vf', `eq=contrast=${contrast}:saturation=${saturation}:brightness=${brightness}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-an', '-movflags', '+faststart',
    out,
  ])
  return out
}

export async function conformVideo({ src, inSec = 0, outSec, speed = 1, width, height, grade, out }) {
  ensureDir(out)
  const rawDur = Math.max(0.1, (outSec ?? (await probe(src)).durationSec) - inSec)
  const targetDur = rawDur / speed
  const chain = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    'setsar=1',
  ]
  if (speed !== 1) chain.splice(3, 0, `setpts=${(1 / speed).toFixed(6)}*PTS`)
  if (grade?.contrast || grade?.saturation) {
    chain.push(`eq=contrast=${grade.contrast ?? 1}:saturation=${grade.saturation ?? 1}`)
  }
  await ffmpeg([
    '-y', '-ss', String(inSec), '-i', src, '-t', String(round3(targetDur)),
    '-vf', chain.join(','),
    '-an', '-r', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    out,
  ])
  return { file: out, durationSec: round3(await durationOf(out)) }
}

export async function applyMotionImage({ src, out, durationSec, width = 1080, height = 1920, zoomMax = 1.12, grade }) {
  ensureDir(out)
  const fps = 30
  const frames = Math.max(1, Math.round(durationSec * fps))
  const step = (zoomMax - 1) / frames
  const chain = [
    `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase`,
    `crop=${width * 2}:${height * 2}`,
    `zoompan=z='min(zoom+${step.toFixed(6)},${zoomMax})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps}`,
    'setsar=1',
  ]
  if (grade?.contrast || grade?.saturation) {
    chain.push(`eq=contrast=${grade.contrast ?? 1}:saturation=${grade.saturation ?? 1}`)
  }
  await ffmpeg([
    '-y', '-loop', '1', '-t', String(round3(durationSec)), '-i', src,
    '-vf', chain.join(','),
    '-frames:v', String(frames),
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    out,
  ])
  return { file: out, durationSec: round3(await durationOf(out)) }
}

export async function colorStats(src, sampleEverySec = 5) {
  const { stdout, stderr } = await ffmpeg(
    ['-y', '-i', src, '-vf', `fps=1/${sampleEverySec},signalstats,metadata=print:file=-`, '-an', '-f', 'null', '-'],
    { captureStdout: true }
  )
  const text = stdout || stderr
  const yAvg = []
  const satAvg = []
  const re = /lavfi\.signalstats\.(YAVG|SATAVG)=([0-9]+(?:\.[0-9]+)?)/g
  let m
  while ((m = re.exec(text)) !== null) {
    if (m[1] === 'YAVG') yAvg.push(parseFloat(m[2]))
    else satAvg.push(parseFloat(m[2]))
  }
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)
  return { brightAvg: mean(yAvg), saturationAvg: mean(satAvg) }
}

export default {
  extractAudio,
  sliceAudio,
  detectScenes,
  makeThumbnail,
  transcodeToMezzanine,
  clipSlice,
  concatClips,
  buildVoiceTrack,
  mixAudio,
  addSubtitles,
  applyGrade,
  conformVideo,
  applyMotionImage,
  colorStats,
  probe,
}
