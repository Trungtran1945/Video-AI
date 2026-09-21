import path from 'path'
import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { query, insert } from '../../db/query.js'
import {
  burnSubtitlesStyled,
  applySubtitleMasks,
  buildDubTrack,
  muxStream,
  makeThumbnail,
  probe,
} from '../../media/mediaService.js'
import { ffmpeg } from '../../media/ffmpeg.js'
import {
  projectDir, ensureDir, requireSourceFile, toStorageKey, round3,
} from '../context.js'

// dub.render (docs/05 §B.7, transflow doc 15 §5): mask/blur hardsub gốc → burn-in ASS → audio mix → mux NVENC.
// BLOCK_RENDER: segment thiếu TTS audio khi dubbing bật → throw, không dùng giọng gốc,
// không mượn file segment khác.
const BURN_TIMEOUT = 20 * 60 * 1000
const MASK_TIMEOUT = 20 * 60 * 1000
const DUB_TRACK_TIMEOUT = 15 * 60 * 1000

export async function dubRender(ctx) {
  const { project, setProgress, signal } = ctx
  const params = parseParams(project.params)
  const src = requireSourceFile(project.source_video_key, 'Video nguồn')
  const dir = ensureDir(projectDir(project.id))

  // Check abort signal
  if (signal?.aborted) throw new Error('Cancelled')

  const info = await probe(src)
  const totalSec = round3(info.durationSec || project.target_duration_sec || 0)

  let workingFile = src
  setProgress(30)

  // ── 1. Mask/blur vùng hardsub gốc (AUTO từ transcript OCR + MANUAL từ API).
  // Chạy TRƯỚC burn ASS để subtitle dịch overlay sau luôn visible (render order:
  // source → mask → translated subtitle → audio mix → mux).
  const maskMethod = params.maskMethod === 'solid' ? 'solid' : 'blur'
  const regions = await loadSubtitleRegions(project.id, { maskMethod })
  const activeMasks = regions.filter((r) => r.enabled !== 0)
  if (activeMasks.length) {
    const maskedFile = path.join(dir, 'masked.mp4')
    await applySubtitleMasks(workingFile, activeMasks, {
      width: info.width || 1280,
      height: info.height || 720,
      out: maskedFile,
      timeout: MASK_TIMEOUT,
    })
    if (workingFile !== src) {
      try { fs.unlinkSync(workingFile) } catch (_) {}
    }
    workingFile = maskedFile
  }
  setProgress(40)

  // ── 2. Burn-in phụ đề dịch dạng ASS \pos theo bbox cũ (docs/05 §B.7) ──
  const segments = await query(
    `SELECT * FROM transcript_segments WHERE project_id = ? AND translation IS NOT NULL AND translation != ''
     ORDER BY start_sec ASC`,
    [project.id]
  )
  if (segments.length) {
    // Minimal plumbing: đọc ocr_regions nếu tồn tại (scale-invariant ratio 0..1),
    // normalize snake_case → camelCase, truyền đúng vào buildAss. Rỗng → fallback đáy.
    const assPath = buildAss(dir, segments, regions, {
      width: info.width || 1280,
      height: info.height || 720,
      title: project.title,
      subPosition: params.subPosition || 'original',
    })
    const burnedFile = path.join(dir, 'burned.mp4')
    await burnSubtitlesStyled(workingFile, assPath, burnedFile, { timeout: BURN_TIMEOUT })
    if (workingFile !== src) {
      try { fs.unlinkSync(workingFile) } catch (_) {}
    }
    workingFile = burnedFile
  }
  setProgress(60)

  // ── 3. Audio mix + mux (docs/05 §B.7, transflow doc 15 §5.3) ──────────
  const enableDubbing = !!params.enableDubbing
  const ext = params.outputFormat === 'mkv' ? '.mkv' : '.mp4'
  const finalFile = path.join(dir, `final${ext}`)
  let fallbackToOriginal = 0

  if (enableDubbing) {
    // Explicit segmentId → audioId → file mapping (NEVER array index).
    const rows = await query(
      `SELECT ts.id, ts.start_sec, ts.end_sec, a.id AS audio_id FROM transcript_segments ts
       LEFT JOIN audios a ON a.id = ts.tts_audio_id
       WHERE ts.project_id = ? AND ts.translation IS NOT NULL AND ts.translation != ''
       ORDER BY ts.start_sec ASC`,
      [project.id]
    )
    const aligns = parseAlignments(ctx.results?.['dub.ttsAlign'])
    const segDir = path.join(dir, 'audio_segments')
    const filesById = new Map()
    if (fs.existsSync(segDir)) {
      for (const f of fs.readdirSync(segDir).filter((x) => x.startsWith('seg_fit_') && x.endsWith('.wav'))) {
        filesById.set(path.join(segDir, f), path.join(segDir, f))
      }
    }
    // Map audioId/segmentId → physical file by scanning for seg_fit_<segmentId> in filename
    const scanForSegment = (segmentId) => {
      const key = String(segmentId || '').replace(/[^A-Za-z0-9_-]/g, '_')
      if (!fs.existsSync(segDir)) return null
      const hit = fs.readdirSync(segDir).find((f) => f.startsWith('seg_fit_') && f.endsWith('.wav') && f.includes(key))
      return hit ? path.join(segDir, hit) : null
    }
    const byAudioOrSegment = new Map()
    for (const [p] of filesById) {
      // index by full path; resolver below matches via scanForSegment + explicit map
      void p
    }
    // Build explicit lookup the resolver understands: audioId→file and segmentId→file
    const lookup = new Map()
    for (const a of aligns) {
      const f = scanForSegment(a.segmentId)
      if (f) {
        if (a.audioId) lookup.set(String(a.audioId), f)
        lookup.set(`seg:${String(a.segmentId)}`, f)
      }
    }
    // Fallback: any seg_fit file containing the segment key (covers retries)
    for (const row of rows) {
      if (!lookup.has(`seg:${String(row.id)}`)) {
        const f = scanForSegment(row.id)
        if (f) lookup.set(`seg:${String(row.id)}`, f)
      }
    }

    const resolved = resolveAudioEntries(rows, aligns, lookup)
    const missing = rows.filter((r) => !resolved.get(String(r.id)))
    if (missing.length > 0) {
      throw new Error(`BLOCK_RENDER: MISSING_TTS_AUDIO — ${missing.length} segment thiếu TTS audio/file riêng (ids: ${missing.map((m) => m.id).join(',')}). Không dùng giọng gốc thay thế, không mượn file segment khác.`)
    }
    const entriesWithTts = [...resolved.values()].map((e) => ({
      file: e.file,
      offsetSec: e.offsetSec,
      segmentId: e.segmentId,
      startAtSec: e.startAtSec,
      endAtSec: e.endAtSec,
    }))
    // Deterministic order + overlap guard before mix (no silent forward-shift)
    entriesWithTts.sort((a, b) => a.offsetSec - b.offsetSec)
    for (let i = 1; i < entriesWithTts.length; i++) {
      if (entriesWithTts[i].offsetSec < entriesWithTts[i - 1].endAtSec - 0.05) {
        throw new Error(`BLOCK_RENDER: OVERLAP — segment ${entriesWithTts[i].segmentId} starts at ${entriesWithTts[i].offsetSec}s before prev ends at ${entriesWithTts[i - 1].endAtSec}s`)
      }
    }
    void byAudioOrSegment
    fallbackToOriginal = 0

    const dubTrackWav = path.join(dir, 'dub_track.wav')
    await buildDubTrack({
      originalMedia: src, // audio gốc làm background, duck ×0.25
      entries: entriesWithTts,
      totalSec,
      out: dubTrackWav,
      backgroundVolume: 0.25,
      timeout: DUB_TRACK_TIMEOUT,
    })
    setProgress(75)
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
  setProgress(90)

  const outputKey = toStorageKey(finalFile)
  const thumbKey = toStorageKey(thumbPath)
  const finalInfo = await probe(finalFile)
  setProgress(95)

  await insert('outputs', {
    id: uuidv4(),
    project_id: project.id,
    storage_key: outputKey,
    status: 'success',
    duration_sec: round3(finalInfo.durationSec),
    thumbnail_key: thumbKey,
  })
  setProgress(100)

  // Trả về thông tin partial success (transflow doc 15 §8.3)
  return {
    outputKey,
    thumbnailKey: thumbKey,
    durationSec: round3(finalInfo.durationSec),
    burnedCues: segments.length,
    dubbedAudio: enableDubbing,
    // Thông tin về segment dùng giọng gốc
    fallbackToOriginal,
  }
}

// Đọc subtitle/mask regions đã persist (nếu có). Scale-invariant ratio 0..1,
// tương ứng resolution video thực tế qua PlayResX/Y + centerOf().
// Gộp regions MANUAL đã lưu + AUTO suy ra từ transcript OCR (bbox đã persist
// trên segment — luôn nhất quán với transcript, dedupe-safe).
// Không hard-code vị trí khi region tồn tại; rỗng → fallback top/bottom/default.
export async function loadSubtitleRegions(projectId, { maskMethod = 'blur' } = {}) {
  try {
    const rows = await query(
      `SELECT * FROM ocr_regions WHERE project_id = ? ORDER BY start_sec ASC`,
      [projectId]
    )
    const stored = (rows || []).map(normalizeRegion).filter(Boolean)
    const auto = await deriveAutoRegions(projectId, maskMethod)
    return [...stored, ...auto]
  } catch (_) {
    return []
  }
}

// Dựng mask AUTO từ transcript OCR (bbox ratio đã persist trên segment).
// Không ghi DB — suy ra lúc render/API nên không bao giờ lệch với transcript.
export async function deriveAutoRegions(projectId, maskMethod) {
  const type = maskMethod === 'solid' ? 'solid' : 'blur'
  const rows = await query(
    `SELECT id, start_sec, end_sec, text, confidence, ratio_x, ratio_y, ratio_w, ratio_h
     FROM transcript_segments
     WHERE project_id = ? AND (source = 'ocr' OR source IS NULL)
       AND ratio_x IS NOT NULL AND ratio_y IS NOT NULL AND ratio_w IS NOT NULL AND ratio_h IS NOT NULL
     ORDER BY start_sec ASC`,
    [projectId]
  )
  const out = []
  for (const s of rows) {
    const r = normalizeRegion({
      ratio_x: s.ratio_x, ratio_y: s.ratio_y, ratio_w: s.ratio_w, ratio_h: s.ratio_h,
      start_sec: s.start_sec, end_sec: s.end_sec,
    })
    if (!r) continue
    out.push({
      ...r,
      id: `auto:${s.id}`,
      type,
      blur_radius: 8,
      opacity: 1,
      enabled: 1,
      text: s.text,
      confidence: s.confidence,
      source: 'AUTO',
    })
  }
  return out
}

export function normalizeRegion(r) {
  if (!r) return null
  const ratioX = Number(r.ratioX ?? r.ratio_x)
  const ratioY = Number(r.ratioY ?? r.ratio_y)
  const ratioW = Number(r.ratioW ?? r.ratio_w)
  const ratioH = Number(r.ratioH ?? r.ratio_h)
  const startSec = Number(r.start_sec ?? r.startSec)
  const endSec = Number(r.end_sec ?? r.endSec)
  if (![ratioX, ratioY, ratioW, ratioH, startSec, endSec].every(Number.isFinite)) return null
  if (ratioW <= 0 || ratioH <= 0) return null
  if (ratioX < 0 || ratioY < 0 || ratioX > 1 || ratioY > 1) return null
  if (!(endSec > startSec)) return null
  const type = r.type === 'solid' ? 'solid' : 'blur'
  const blurRaw = Number(r.blur_radius ?? r.blurRadius ?? 8)
  const opRaw = Number(r.opacity ?? r.mask_strength ?? 1)
  const enabled = r.enabled === 0 || r.enabled === false || r.enabled === '0' ? 0 : 1
  return {
    id: r.id ?? null,
    ratioX, ratioY, ratioW: Math.min(1, ratioW), ratioH: Math.min(1, ratioH),
    start_sec: startSec, end_sec: endSec,
    type,
    blur_radius: Number.isFinite(blurRaw) ? blurRaw : 8,
    opacity: Number.isFinite(opRaw) ? opRaw : 1,
    enabled,
    text: typeof r.text === 'string' ? r.text : null,
    confidence: Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : null,
    source: r.source || 'AUTO',
  }
}

// Sinh file ASS với Dialogue \pos định vị theo vùng mask (tính từ ratioX/Y/W/H).
// subPosition: 'original' (đè lên vùng mask) | 'top' | 'bottom' | 'custom' (docs/01 §3.2).
export function buildAss(dir, segments, regions, { width, height, title, subPosition = 'original' }) {
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

  // Vị trí pixel từ tỷ lệ (scale-invariant): tâm ngang bbox, lệch lên trên 1 chút.
  const centerOf = (r) => ({
    cx: Math.round((Number(r.ratioX) + Number(r.ratioW) / 2) * width),
    cy: Math.round((Number(r.ratioY) + Number(r.ratioH) * 0.72) * height),
  })
  const lines = segments.map((seg) => {
    const region = pickRegion(regions, Number(seg.start_sec), Number(seg.end_sec))
    const text = escapeAssText(seg.translation)
    const end = alignEnd(seg, regions)
    if (region && subPosition === 'original') {
      // Đè lên vùng mask cũ (docs/05 §B.7: phụ đề mới đè đúng chỗ hardsub gốc)
      const { cx, cy } = centerOf(region)
      return `Dialogue: 0,${assTime(Number(seg.start_sec))},${assTime(end)},Dub,,0,0,0,,{\\an5\\pos(${cx},${cy})}${text}`
    }
    if (subPosition === 'top') {
      const cx = Math.round(width / 2)
      const cy = Math.round(height * 0.12)
      return `Dialogue: 0,${assTime(Number(seg.start_sec))},${assTime(end)},Dub,,0,0,0,,{\\an8\\pos(${cx},${cy})}${text}`
    }
    if (subPosition === 'bottom') {
      const cx = Math.round(width / 2)
      const cy = Math.round(height * 0.90)
      return `Dialogue: 0,${assTime(Number(seg.start_sec))},${assTime(end)},Dub,,0,0,0,,{\\an2\\pos(${cx},${cy})}${text}`
    }
    // 'custom' (chưa có toạ độ riêng) hoặc không có region → mặc định đáy khung
    return `Dialogue: 0,${assTime(Number(seg.start_sec))},${assTime(end)},Dub,,0,0,0,,{\\an2}${text}`
  })

  const filePath = path.join(dir, 'subtitles.ass')
  fs.writeFileSync(filePath, header + '\n' + lines.join('\n') + '\n', 'utf8')
  return filePath
}

export function pickRegion(regions, startSec, endSec) {
  const mid = (startSec + endSec) / 2
  return (regions || []).find((r) => r.enabled !== 0 && mid >= Number(r.start_sec) && mid <= Number(r.end_sec)) || null
}

// Kéo dài end tới hết region nếu câu kết thúc sát mép dưới của vùng chữ đang hiển thị.
export function alignEnd(seg, regions) {
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

/**
 * Explicit segmentId → audio file resolver. NEVER index-based.
 * rows: [{id, start_sec, end_sec, audio_id}], aligns: [{segmentId, audioId, startAtSec, endAtSec}],
 * filesById: Map(audioId→file) and/or Map('seg:<segmentId>'→file) and/or Map(file→file) / plain path values.
 * Returns Map(segmentId→{file, offsetSec, segmentId, audioId, startAtSec, endAtSec}).
 * Missing audio → no entry (caller BLOCK_RENDERs). Never borrows another segment's file.
 */
export function resolveAudioEntries(rows, aligns, filesById) {
  const out = new Map()
  const byAudio = new Map()
  const bySeg = new Map()
  if (filesById instanceof Map) {
    for (const [k, v] of filesById) {
      if (typeof k === 'string' && k.startsWith('seg:')) bySeg.set(k.slice(4), v)
      else if (typeof v === 'string' && v) {
        byAudio.set(String(k), v)
        // Also allow direct segmentId→file entries
        bySeg.set(String(k), v)
      }
    }
  }
  const alignBySeg = new Map((aligns || []).map((a) => [String(a.segmentId), a]))
  // Track used files to enforce 1:1 (no duplicate audio across segments)
  const used = new Set()
  for (const row of rows || []) {
    const sid = String(row.id)
    if (!row.audio_id) continue
    const align = alignBySeg.get(sid)
    if (align && align.audioId && String(align.audioId) !== String(row.audio_id)) continue
    let file = byAudio.get(String(row.audio_id)) || bySeg.get(sid) || bySeg.get(String(row.audio_id)) || null
    // Direct path value support: filesById may be Map(audioId→path)
    if (!file && filesById instanceof Map) {
      for (const [, v] of filesById) {
        if (typeof v === 'string' && v.endsWith('.wav') && v.includes(String(sid).replace(/[^A-Za-z0-9_-]/g, '_'))) { file = v; break }
      }
    }
    if (!file) continue
    if (used.has(file)) continue // duplicate assignment blocked
    try {
      if (!fs.existsSync(file)) continue
    } catch (_) { continue }
    used.add(file)
    out.set(sid, {
      file,
      offsetSec: align ? Number(align.startAtSec) : Number(row.start_sec),
      segmentId: sid,
      audioId: String(row.audio_id),
      startAtSec: align ? Number(align.startAtSec) : Number(row.start_sec),
      endAtSec: align ? Number(align.endAtSec) : Number(row.end_sec),
    })
  }
  return out
}

export default dubRender
