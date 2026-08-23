import fs from 'node:fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { query } from '../../db/query.js'
import { projectDir, ensureDir, toStorageKey, round2, insertMany } from '../context.js'

const MIN_CUE_SEC = 1.0

function splitSentences(text) {
  const parts = String(text || '')
    .split(/(?<=[.!?…。])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length ? parts : [String(text || '').trim()].filter(Boolean)
}

function srtTimestamp(sec) {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const rest = ms % 1000
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(rest, 3)}`
}

export function buildCuesFromWindows(windows) {
  const cues = []
  for (const w of windows) {
    const sentences = splitSentences(w.text)
    if (!sentences.length) continue
    const totalChars = sentences.reduce((a, s) => a + s.length, 0) || 1
    let cursor = w.startSec
    const limit = w.startSec + w.durationSec
    for (const sentence of sentences) {
      let dur = Math.max(MIN_CUE_SEC, (sentence.length / totalChars) * w.durationSec)
      let end = cursor + dur
      if (end > limit) {
        end = limit
        dur = end - cursor
      }
      if (dur <= 0.15) break
      cues.push({ start: round2(cursor), end: round2(end), text: sentence })
      cursor = end
      if (cursor >= limit - 0.05) break
    }
  }
  return cues.sort((a, b) => a.start - b.start)
}

export function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTimestamp(c.start)} --> ${srtTimestamp(c.end)}\n${c.text}\n`).join('\n')
}

export async function summarySubtitle(ctx) {
  const { project } = ctx
  const segments = await query(
    'SELECT id, narration, voice_audio_id FROM script_segments WHERE project_id = ? ORDER BY index_num ASC',
    [project.id]
  )
  if (!segments.length) {
    throw new Error('Chưa có kịch bản — hãy retry từ stage summary.script')
  }
  const clips = await query(
    'SELECT voice_audio_id, MIN(start_at_sec) AS start_at_sec FROM timeline_clips WHERE project_id = ? GROUP BY voice_audio_id',
    [project.id]
  )
  const audios = await query('SELECT id, duration_sec FROM audios WHERE project_id = ?', [project.id])
  const clipStartById = new Map(clips.map((c) => [c.voice_audio_id, c.start_at_sec]))
  const audioDurById = new Map(audios.map((a) => [a.id, Number(a.duration_sec) || 0]))

  const windows = []
  for (const seg of segments) {
    if (!seg.voice_audio_id) continue
    const startAt = clipStartById.get(seg.voice_audio_id)
    if (startAt == null) continue
    windows.push({
      text: seg.narration,
      startSec: Number(startAt),
      durationSec: audioDurById.get(seg.voice_audio_id) || 5,
    })
  }
  if (!windows.length) {
    throw new Error('Chưa có timeline/giọng đọc — hãy retry từ stage summary.align')
  }

  const cues = buildCuesFromWindows(windows)
  if (!cues.length) throw new Error('Không sinh được cue phụ đề nào')

  const dir = ensureDir(projectDir(project.id))
  const srtPath = path.join(dir, 'subtitles.srt')
  fs.writeFileSync(srtPath, '\uFEFF' + toSrt(cues), 'utf8')

  await insertMany('subtitles', [
    {
      id: uuidv4(),
      project_id: project.id,
      format: 'srt',
      language: project.language || 'vi',
      storage_key: toStorageKey(srtPath),
      cues: JSON.stringify(cues),
    },
  ])

  return { subtitleKey: toStorageKey(srtPath), cueCount: cues.length }
}

export default summarySubtitle
