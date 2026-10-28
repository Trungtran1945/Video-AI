import fs from 'node:fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { query, run } from '../../db/query.js'
import { projectDir, ensureDir, toStorageKey, dimsForAspect } from '../context.js'
import { buildCuesFromWindows, toSrt } from './summarySubtitle.js'

function assTimestamp(sec) {
  const totalCs = Math.max(0, Math.round(Number(sec) * 100))
  const cs = totalCs % 100
  const totalSec = Math.floor(totalCs / 100)
  const s = totalSec % 60
  const m = Math.floor(totalSec / 60) % 60
  const h = Math.floor(totalSec / 3600)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`
}

function escapeAssText(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N')
}

export function toAss(cues, { width = 1920, height = 1080 } = {}) {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const fontSize = Math.round(48 * Math.min(w, h) / 1080) || 48
  const marginV = Math.max(24, Math.round(h * 0.04))
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Script,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  for (const cue of cues) {
    lines.push(`Dialogue: 0,${assTimestamp(cue.start)},${assTimestamp(cue.end)},Script,,0,0,0,,${escapeAssText(cue.text)}`)
  }
  return lines.join('\n') + '\n'
}

// script.subtitle — SRT for download plus ASS for burned-in render. Cue timing
// comes from the same segment windows used by align, so text, audio and
// picture share one timeline.
export async function scriptSubtitle(ctx) {
  const { project, setProgress } = ctx
  const segments = await query(
    'SELECT id, index_num, narration, voice_audio_id FROM script_segments WHERE project_id = ? ORDER BY index_num ASC',
    [project.id]
  )
  if (!segments.length) throw new Error('Chưa có đoạn kịch bản — hãy retry từ stage script.analyze')

  const clips = await query(
    'SELECT voice_audio_id, start_at_sec, out_sec, in_sec FROM timeline_clips WHERE project_id = ? ORDER BY order_index ASC',
    [project.id]
  )
  if (!clips.length) throw new Error('Chưa có timeline — hãy retry từ stage script.align')
  const startByAudio = new Map(clips.map((c) => [c.voice_audio_id, Number(c.start_at_sec) || 0]))
  const durByAudio = new Map(clips.map((c) => [c.voice_audio_id, Math.max(0, Number(c.out_sec) - Number(c.in_sec || 0))]))

  const windows = []
  for (const seg of segments) {
    if (!seg.voice_audio_id) continue
    const startSec = startByAudio.get(seg.voice_audio_id)
    if (startSec == null) continue
    windows.push({
      text: seg.narration,
      startSec,
      durationSec: durByAudio.get(seg.voice_audio_id) || 0,
    })
  }
  if (!windows.length) throw new Error('Chưa có timeline/giọng đọc — hãy retry từ stage script.align')

  const cues = buildCuesFromWindows(windows)
  if (!cues.length) throw new Error('Không sinh được cue phụ đề nào')
  setProgress(40)

  const dir = ensureDir(projectDir(project.id))
  const srtPath = path.join(dir, 'subtitles.srt')
  const assPath = path.join(dir, 'subtitles.ass')
  fs.writeFileSync(srtPath, '\uFEFF' + toSrt(cues), 'utf8')
  const { width, height } = dimsForAspect(project.aspect_ratio)
  fs.writeFileSync(assPath, toAss(cues, { width, height }), 'utf8')

  await run('DELETE FROM subtitles WHERE project_id = ?', [project.id])
  const now = new Date().toISOString()
  const language = project.language || 'vi'
  const srtKey = toStorageKey(srtPath)
  const assKey = toStorageKey(assPath)
  await run(
    `INSERT INTO subtitles (id, project_id, format, language, storage_key, cues) VALUES (?, ?, 'srt', ?, ?, ?)`,
    [uuidv4(), project.id, language, srtKey, JSON.stringify(cues)]
  )
  await run(
    `INSERT INTO subtitles (id, project_id, format, language, storage_key, cues) VALUES (?, ?, 'ass', ?, ?, ?)`,
    [uuidv4(), project.id, language, assKey, JSON.stringify(cues)]
  )
  await run(
    `UPDATE script_segments SET subtitle_id = (SELECT id FROM subtitles WHERE project_id = ? AND format = 'srt' LIMIT 1), updated_at = ? WHERE project_id = ? AND voice_audio_id IS NOT NULL`,
    [project.id, now, project.id]
  )

  setProgress(98)
  return { cueCount: cues.length, srtKey, assKey }
}

export default scriptSubtitle
