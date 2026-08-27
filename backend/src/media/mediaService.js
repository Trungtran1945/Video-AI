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

// ── TRANSLATE_DUB helpers (docs/07 §2.11–2.15) ───────────────────────────

// Nén audio sang MP3 16kHz mono trước khi upload STT (Groq/Whisper giới hạn ~25MB/file,
// chunk WAV 600s dễ vượt quá → bản nén chỉ ~5MB).
export async function compressAudioForUpload(src, out) {
  ensureDir(out)
  await ffmpeg(['-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', out])
  return out
}

// Trích frame theo tần suất fps cho OCR (cap số lượng để tiết kiệm GPU/chi phí).
export async function sampleFrames(src, outDir, { fps = 2, cap = 600 } = {}) {
  ensureDir(outDir)
  const info = await probe(src)
  if (!info.durationSec) return []
  let effFps = fps
  let count = Math.ceil(info.durationSec * effFps)
  if (count > cap) {
    effFps = Math.max(0.2, cap / info.durationSec)
    count = cap
  }
  await ffmpeg([
    '-y', '-i', src,
    '-vf', `fps=${round3(effFps)},scale='min(1280,iw)':-2`,
    '-q:v', '3',
    path.join(outDir, 'frame_%05d.jpg'),
  ])
  const times = []
  for (let i = 0; i < count; i++) times.push(round2(i / effFps))
  const files = fs.readdirSync(outDir).filter((f) => f.startsWith('frame_') && f.endsWith('.jpg')).sort()
  return files.map((f, i) => ({ file: path.join(outDir, f), t: times[i] ?? round2(i / effFps) }))
}

// Chuẩn hoá âm lượng EBU R128 (docs/07 §2.12) — mặc định −16 LUFS.
export async function normalizeLoudness(inFile, out, targetLufs = -16) {
  ensureDir(out)
  // Pass 1: đo loudness
  const { stderr } = await ffmpeg(['-y', '-i', inFile, '-af', `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-'])
  let measured = ''
  const jsonMatch = stderr.match(/\{[\s\S]*"input_i"[\s\S]*\}/)
  if (jsonMatch) measured = jsonMatch[0].replace(/\n/g, '').trim()
  // Pass 2: áp dụng (linear=true khi đã biết thông số đo được)
  const args = ['-y', '-i', inFile]
  if (measured) {
    try {
      const stats = JSON.parse(measured)
      args.push('-af', `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true`)
    } catch (_) {
      args.push('-af', `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11`)
    }
  } else {
    args.push('-af', `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11`)
  }
  args.push('-ar', '48000', '-ac', '2', out)
  await ffmpeg(args)
  return out
}

// Sample màu nền quanh bbox (docs/05 §B.6) — đọc pixel thô rgb24 1×1.
async function samplePointColor(src, atSec, x, y, w, h) {
  const raw = path.join(path.dirname(src), `_color_${uuidv4()}.raw`)
  try {
    await ffmpeg([
      '-y', '-ss', String(Math.max(0, atSec)), '-i', src,
      '-vf', `crop=${Math.max(2, w)}:${Math.max(2, h)}:${Math.max(0, x)}:${Math.max(0, y)},scale=1:1`,
      '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw,
    ])
    const buf = fs.readFileSync(raw)
    if (buf.length >= 3) return { r: buf[0], g: buf[1], b: buf[2] }
    return null
  } catch (_) {
    return null
  } finally {
    try { fs.unlinkSync(raw) } catch (_) {}
  }
}

// Lấy màu nền đại diện quanh vùng chữ (trên/dưới/trái/phải bbox).
export async function sampleBackgroundColor(src, atSec, region, videoDims) {
  const vw = videoDims?.width || 1280
  const vh = videoDims?.height || 720
  const pad = 8
  const candidates = [
    await samplePointColor(src, atSec, region.x, Math.max(0, region.y - pad), region.width, 2),
    await samplePointColor(src, atSec, region.x, Math.min(vh - 2, region.y + region.height + pad - 2), region.width, 2),
    await samplePointColor(src, atSec, Math.max(0, region.x - pad), region.y, 2, region.height),
    await samplePointColor(src, atSec, Math.min(vw - 2, region.x + region.width + pad - 2), region.y, 2, region.height),
  ].filter(Boolean)
  if (!candidates.length) return '0x202020'
  const avg = candidates.reduce((acc, c) => ({ r: acc.r + c.r, g: acc.g + c.g, b: acc.b + c.b }), { r: 0, g: 0, b: 0 })
  const n = candidates.length
  const hex = (v) => Math.round(v / n).toString(16).padStart(2, '0')
  return `0x${hex(avg.r)}${hex(avg.g)}${hex(avg.b)}`
}

// Che vùng hardsub theo từng OcrRegion, chỉ bật trong khoảng thời gian của nó
// (docs/07 §2.13). method: 'blur' | 'fill' | 'delogo'.
export async function maskRegions(src, regions, out, { method = 'fill', videoDims } = {}) {
  ensureDir(out)
  if (!regions.length) {
    await ffmpeg(['-y', '-i', src, '-an', '-c', 'copy', '-movflags', '+faststart', out])
    return out
  }

  if (method === 'blur') {
    // Crop từng bbox → boxblur mạnh → overlay trả về đúng vị trí, enable theo thời gian
    const inputs = ['-i', src]
    const filters = []
    let prevLabel = '0:v'
    regions.forEach((r, i) => {
      const bw = Math.max(2, Math.round(r.width))
      const bh = Math.max(2, Math.round(r.height))
      filters.push(`[${prevLabel}]crop=${bw}:${bh}:${Math.round(r.x)}:${Math.round(r.y)},boxblur=luma_radius=min(h,w)/6:luma_power=2[b${i}]`)
      prevLabel = `ov${i}`
      filters.push(`[${i === 0 ? '0:v' : `[ov${i - 1}]`}][b${i}]overlay=${Math.round(r.x)}:${Math.round(r.y)}:enable='between(t,${round2(r.start_sec)},${round2(r.end_sec)})'[${prevLabel}]`)
    })
    filters.push(`[${prevLabel}]setsar=1[vout]`)
    await ffmpeg([...inputs, '-filter_complex', filters.join(';'), '-map', '[vout]', '-an', ...(await encodeArgs()), '-movflags', '+faststart', out])
    return out
  }

  if (method === 'delogo') {
    const chain = regions
      .map((r) => `delogo=x=${Math.round(r.x)}:y=${Math.round(r.y)}:w=${Math.max(2, Math.round(r.width))}:h=${Math.max(2, Math.round(r.height))}:enable='between(t,${round2(r.start_sec)},${round2(r.end_sec)})'`)
      .concat('setsar=1')
      .join(',')
    await ffmpeg(['-y', '-i', src, '-vf', chain, '-an', ...(await encodeArgs()), '-movflags', '+faststart', out])
    return out
  }

  // 'fill' — lấp màu nền sampling quanh bbox (mặc định, docs/05 §D)
  const colors = []
  for (const r of regions) {
    colors.push(await sampleBackgroundColor(src, (r.start_sec + r.end_sec) / 2, r, videoDims))
  }
  const chain = regions
    .map((r, i) => `drawbox=x=${Math.round(r.x)}:y=${Math.round(r.y)}:w=${Math.max(2, Math.round(r.width))}:h=${Math.max(2, Math.round(r.height))}:color=${colors[i]}@1:t=fill:enable='between(t,${round2(r.start_sec)},${round2(r.end_sec)})'`)
    .concat('setsar=1')
    .join(',')
  await ffmpeg(['-y', '-i', src, '-vf', chain, '-an', ...(await encodeArgs()), '-movflags', '+faststart', out])
  return out
}

// Burn-in phụ đề ASS có \pos định vị theo bbox cũ (docs/07 §2.14).
export async function burnSubtitlesStyled(inFile, assPath, out) {
  ensureDir(out)
  const cwd = path.dirname(assPath)
  const base = path.basename(assPath)
  await ffmpeg(
    ['-y', '-i', inFile, '-vf', `ass=${base}`, ...(await encodeArgs()), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
    { cwd }
  )
  return out
}

// Áp tempo + chèn im lặng cho 1 segment dub (docs/07 §2.5 applySpeed tương ứng).
export async function applyTempoAudio(inFile, out, { tempo = 1, padBeforeSec = 0, padAfterSec = 0 } = {}) {
  ensureDir(out)
  const filters = []
  if (tempo && tempo !== 1) filters.push(`atempo=${clampNum(tempo, 0.5, 2)}`)
  if (padBeforeSec > 0) filters.push(`adelay=${Math.round(padBeforeSec * 1000)}:all=1`)
  filters.push(`apad=pad_dur=${Math.max(0, round3(padAfterSec))}`)
  filters.push('aresample=48000')
  await ffmpeg(['-y', '-i', inFile, '-af', filters.join(','), '-ac', '2', '-ar', '48000', out])
  return out
}

// Ghép các segment dub theo offset + trộn với audio gốc làm nền (ducking −12dB ≈ ×0.25).
// originalMedia: file video/audio nguồn để lấy background; entries: [{file, offsetSec}].
export async function buildDubTrack({ originalMedia, entries = [], totalSec, out, backgroundVolume = 0.25 } = {}) {
  ensureDir(out)
  const info = await probe(originalMedia)
  const inputs = ['-i', originalMedia] // [0] background gốc
  const filters = []
  const labels = []
  entries.forEach((e, i) => {
    inputs.push('-i', e.file)
    filters.push(`[${i + 1}:a]aresample=48000,adelay=${Math.max(0, Math.round((e.offsetSec || 0) * 1000))}:all=1[d${i}]`)
    labels.push(`[d${i}]`)
  })
  let tail
  if (entries.length > 1) {
    filters.push(`${labels.join('')}amix=inputs=${entries.length}:duration=longest:normalize=0[dub]`)
    tail = '[dub]'
  } else if (entries.length === 1) {
    tail = labels[0]
  } else {
    tail = null
  }

  let mapLabel
  if (tail && info.hasAudio) {
    filters.push(`[0:a]aresample=48000,volume=${backgroundVolume}[bg]`)
    filters.push(`${tail}[bg]amix=inputs=2:duration=first:normalize=0,apad,atrim=0:${round3(totalSec)},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]`)
    mapLabel = '[aout]'
  } else if (tail) {
    filters.push(`${tail}apad,atrim=0:${round3(totalSec)},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]`)
    mapLabel = '[aout]'
  } else if (info.hasAudio) {
    filters.push(`[0:a]volume=1.0,apad,atrim=0:${round3(totalSec)},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]`)
    mapLabel = '[aout]'
  } else {
    filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${round3(totalSec)}[aout]`)
    mapLabel = '[aout]'
  }

  await ffmpeg([...inputs, '-filter_complex', filters.join(';'), '-map', mapLabel, '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', out])
  return out
}

// Mux video + audio thành MP4/MKV hoàn chỉnh (docs/07 §2.15).
export async function muxStream(inVideo, inAudio, out, { format = 'mp4' } = {}) {
  ensureDir(out)
  const args = [
    '-y', '-i', inVideo, '-i', inAudio,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-shortest',
  ]
  if (format === 'mp4') args.push('-movflags', '+faststart')
  args.push(out)
  await ffmpeg(args)
  return out
}

// ── Hardware encoder (NVENC ưu tiên, fallback libx264 — docs/07 §2.15/§4) ──
let nvencAvailable = null // cache kết quả probe

function clampNum(n, min, max) {
  return Math.min(max, Math.max(min, Number(n) || min))
}

function baseQualityArgs() {
  return ['-pix_fmt', 'yuv420p']
}

async function encodeArgs() {
  if (nvencAvailable === null) {
    try {
      const { stderr } = await ffmpeg(['-hide_banner', '-encoders'])
      nvencAvailable = stderr.includes('h264_nvenc')
    } catch (_) {
      nvencAvailable = false
    }
  }
  if (nvencAvailable) {
    return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', ...baseQualityArgs()]
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', ...baseQualityArgs()]
}

// Chạy encode với NVENC; nếu GPU lỗi thật sự khi encode → thử lại libx264.
export async function encodeVideo(argsWithoutEncoderAndOutput, out) {
  ensureDir(out)
  try {
    await ffmpeg([...argsWithoutEncoderAndOutput, ...(await encodeArgs()), '-movflags', '+faststart', out])
    return out
  } catch (err) {
    if (nvencAvailable) {
      console.warn('[Media] NVENC encode thất bại, fallback libx264:', err.message.slice(0, 200))
      await ffmpeg([...argsWithoutEncoderAndOutput, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', ...baseQualityArgs(), '-movflags', '+faststart', out])
      return out
    }
    throw err
  }
}

export default {
  extractAudio,
  sliceAudio,
  compressAudioForUpload,
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
  sampleFrames,
  normalizeLoudness,
  sampleBackgroundColor,
  maskRegions,
  burnSubtitlesStyled,
  applyTempoAudio,
  buildDubTrack,
  muxStream,
  encodeVideo,
}
