import path from 'path'
import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { query, insert } from '../../db/query.js'
import {
  maskRegions,
  burnSubtitlesStyled,
  buildDubTrack,
  muxStream,
  makeThumbnail,
  probe,
} from '../../media/mediaService.js'
import { ffmpeg } from '../../media/ffmpeg.js'
import {
  projectDir, ensureDir, requireSourceFile, toStorageKey, round3,
} from '../context.js'

// dub.render (docs/05 §B.6–B.7): mask hardsub → burn-in ASS → audio mix → mux NVENC.
export async function dubRender(ctx) {
  const { project, setProgress } = ctx
  const params = parseParams(project.params)
  const src = requireSourceFile(project.source_video_key, 'Video nguồn')
  const dir = ensureDir(projectDir(project.id))
  const info = await probe(src)
  const totalSec = round3(info.durationSec || project.target_duration_sec || 0)

  // ── 1. Mask hardsub theo OcrRegion (docs/05 §B.6) ─────────────────────
  const regions = await query(
    'SELECT * FROM ocr_regions WHERE project_id = ? ORDER BY start_sec ASC',
    [project.id]
  )
  let workingFile = src
  if (regions.length) {
    const maskedFile = path.join(dir, 'masked.mp4')
    // 'inpaint' chưa có model AI offline → xấp xỉ bằng delogo (docs/07 §2.13);
    // 'fill' giữ nguyên hành vi lấp màu nền sample.
    const maskMethodMap = { blur: 'blur', delogo: 'delogo', inpaint: 'delogo' }
    await maskRegions(src, regions, maskedFile, {
      method: maskMethodMap[params.maskMethod] || 'fill',
      videoDims: { width: info.width, height: info.height },
    })
    workingFile = maskedFile
  }
  setProgress(30)

  // ── 2. Burn-in phụ đề dịch dạng ASS \pos theo bbox cũ (docs/05 §B.7) ──
  const segments = await query(
    `SELECT * FROM transcript_segments WHERE project_id = ? AND translation IS NOT NULL AND translation != ''
     ORDER BY start_sec ASC`,
    [project.id]
  )
  if (segments.length) {
    const assPath = buildAss(dir, segments, regions, {
      width: info.width || 1280,
      height: info.height || 720,
      title: project.title,
    })
    const burnedFile = path.join(dir, 'burned.mp4')
    await burnSubtitlesStyled(workingFile, assPath, burnedFile)
    if (workingFile !== src) {
      try { fs.unlinkSync(workingFile) } catch (_) {}
    }
    workingFile = burnedFile
  }
  setProgress(60)

  // ── 3. Audio mix + mux (docs/05 §B.7) ─────────────────────────────────
  const enableDubbing = !!params.enableDubbing
  const ext = params.outputFormat === 'mkv' ? '.mkv' : '.mp4'
  const finalFile = path.join(dir, `final${ext}`)

  if (enableDubbing) {
    // Segment audio đã được tạo & căn offset ở dub.ttsAlign (audio_segments/*.wav
    // đặt tên seg_fit_XXXXX.wav đúng thứ tự start_sec tăng dần).
    const rows = await query(
      `SELECT ts.start_sec, a.id AS audio_id FROM transcript_segments ts
       JOIN audios a ON a.id = ts.tts_audio_id
       WHERE ts.project_id = ? ORDER BY ts.start_sec ASC`,
      [project.id]
    )
    const aligns = parseAlignments(ctx.results?.['dub.ttsAlign'])
    const segDir = path.join(dir, 'audio_segments')
    const files = fs.existsSync(segDir)
      ? fs.readdirSync(segDir).filter((f) => f.startsWith('seg_fit_') && f.endsWith('.wav')).sort()
      : []

    const entries = []
    rows.forEach((row, i) => {
      const file = files[i] ? path.join(segDir, files[i]) : null
      if (!file || !fs.existsSync(file)) return
      const align = aligns.find((a) => String(a.audioId) === String(row.audio_id))
      entries.push({ file, offsetSec: align ? align.startAtSec : Number(row.start_sec) })
    })

    const dubTrackWav = path.join(dir, 'dub_track.wav')
    await buildDubTrack({
      originalMedia: src, // audio gốc làm background, duck ×0.25
      entries,
      totalSec,
      out: dubTrackWav,
      backgroundVolume: 0.25,
    })
    await muxStream(workingFile, dubTrackWav, finalFile, { format: ext === '.mkv' ? 'mkv' : 'mp4' })
    try { fs.unlinkSync(dubTrackWav) } catch (_) {}
  } else {
    // Dubbing tắt: giữ nguyên audio gốc (docs/07 §2.15)
    await ffmpeg([
      '-y', '-i', workingFile, '-i', src,
      '-map', '0:v:0', '-map', '1:a:0?',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest',
      ...(ext === '.mp4' ? ['-movflags', '+faststart'] : []),
      finalFile,
    ])
  }
  if (workingFile !== src) {
    try { fs.unlinkSync(workingFile) } catch (_) {}
  }
  setProgress(85)

  // ── 4. Thumbnail + outputs row ─────────────────────────────────────────
  const thumbPath = path.join(dir, 'thumb.jpg')
  await makeThumbnail(finalFile, Math.max(0, Math.min(totalSec / 2, totalSec - 0.5)), thumbPath)

  const outputKey = toStorageKey(finalFile)
  const thumbKey = toStorageKey(thumbPath)
  const finalInfo = await probe(finalFile)
  await insert('outputs', {
    id: uuidv4(),
    project_id: project.id,
    storage_key: outputKey,
    status: 'success',
    duration_sec: round3(finalInfo.durationSec),
    thumbnail_key: thumbKey,
  })

  return {
    outputKey,
    thumbnailKey: thumbKey,
    durationSec: round3(finalInfo.durationSec),
    regionCount: regions.length,
    burnedCues: segments.length,
    dubbedAudio: enableDubbing,
  }
}

// Sinh file ASS với Dialogue \pos định vị theo bbox hardsub tương ứng (docs/07 §2.14).
function buildAss(dir, segments, regions, { width, height, title }) {
  const header = [
    '[Script Info]',
    `Title: ${title || 'SubVideo AI dub'}`,
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Dub,Arial,42,&H00FFFFFF,&H000000FF,&H00202020,&H80000000,-1,0,0,0,100,100,0,0,1,2.5,1,2,40,40,40,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')

  const lines = segments.map((seg) => {
    const region = pickRegion(regions, Number(seg.start_sec), Number(seg.end_sec))
    const text = escapeAssText(seg.translation)
    const end = alignEnd(seg, regions)
    if (region) {
      // Đặt giữa bbox cũ (docs/05 §B.7: phụ đề mới đè lên vị trí cũ)
      const cx = Math.round(region.x + region.width / 2)
      const cy = Math.round(region.y + region.height * 0.72)
      return `Dialogue: 0,${assTime(Number(seg.start_sec))},${assTime(end)},Dub,,0,0,0,,{\\an5\\pos(${cx},${cy})}${text}`
    }
    return `Dialogue: 0,${assTime(Number(seg.start_sec))},${assTime(end)},Dub,,0,0,0,,{\\an2}${text}`
  })

  const filePath = path.join(dir, 'subtitles.ass')
  fs.writeFileSync(filePath, header + '\n' + lines.join('\n') + '\n', 'utf8')
  return filePath
}

function pickRegion(regions, startSec, endSec) {
  const mid = (startSec + endSec) / 2
  return regions.find((r) => mid >= Number(r.start_sec) && mid <= Number(r.end_sec)) || null
}

// Kéo dài end tới hết region nếu câu kết thúc sát mép dưới của vùng chữ đang hiển thị.
function alignEnd(seg, regions) {
  const end = Number(seg.end_sec)
  const region = pickRegion(regions, Number(seg.start_sec), end)
  if (region && end < Number(region.end_sec) && Number(region.end_sec) - end < 1.2) {
    return round3(Number(region.end_sec))
  }
  return round3(end)
}

function escapeAssText(text) {
  return String(text || '').replace(/\r?\n/g, '\\N').replace(/\{/g, '(').replace(/\}/g, ')')
}

function assTime(sec) {
  const total = Math.max(0, Math.round(sec * 100))
  const cs = total % 100
  const s = Math.floor(total / 100) % 60
  const m = Math.floor(total / 6000) % 60
  const h = Math.floor(total / 360000)
  const p2 = (n) => String(n).padStart(2, '0')
  return `${h}:${p2(m)}:${p2(s)}.${p2(cs)}`
}

function parseParams(raw) {
  try { return raw ? JSON.parse(raw) : {} } catch (_) { return {} }
}

function parseAlignments(result) {
  if (!result) return []
  if (Array.isArray(result.alignments)) return result.alignments
  return []
}

export default dubRender
