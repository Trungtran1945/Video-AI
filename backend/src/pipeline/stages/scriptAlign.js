import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { query, run } from '../../db/query.js'
import { probe } from '../../media/mediaService.js'
import {
  resolveStorageKey,
  insertMany,
  round3,
} from '../context.js'

// script.align — rebuild the image timeline from segment audio durations.
// One image clip per segment, cumulative start times, no overlap/gap.
export async function scriptAlign(ctx) {
  const { project, setProgress, signal } = ctx
  const segments = await query(
    'SELECT * FROM script_segments WHERE project_id = ? ORDER BY index_num ASC',
    [project.id]
  )
  if (!segments.length) throw new Error('Chưa có đoạn kịch bản — hãy retry từ stage script.analyze')

  const audios = await query('SELECT * FROM audios WHERE project_id = ?', [project.id])
  const assets = await query('SELECT * FROM assets WHERE project_id = ?', [project.id])
  const audioById = new Map(audios.map((a) => [a.id, a]))
  const assetById = new Map(assets.map((a) => [a.id, a]))

  const clips = []
  let cursor = 0
  for (let i = 0; i < segments.length; i++) {
    if (signal?.aborted) throw new Error('Cancelled')
    const seg = segments[i]
    if (!seg.voice_audio_id) throw new Error(`Đoạn #${seg.index_num} chưa có giọng đọc — retry từ stage script.tts`)
    if (!seg.image_asset_id) throw new Error(`Đoạn #${seg.index_num} chưa có ảnh — retry từ stage script.image`)

    const audio = audioById.get(seg.voice_audio_id)
    if (!audio) throw new Error(`Không tìm thấy audio của đoạn #${seg.index_num}`)
    const asset = assetById.get(seg.image_asset_id)
    if (!asset) throw new Error(`Không tìm thấy ảnh của đoạn #${seg.index_num}`)

    const audioAbs = resolveStorageKey(audio.storage_key)
    if (!audioAbs || !fs.existsSync(audioAbs)) {
      throw new Error(`File giọng đọc của đoạn #${seg.index_num} không tồn tại — retry từ stage script.tts`)
    }
    const assetAbs = resolveStorageKey(asset.storage_key)
    if (!assetAbs || !fs.existsSync(assetAbs)) {
      throw new Error(`File ảnh của đoạn #${seg.index_num} không tồn tại — retry từ stage script.image`)
    }

    const info = await probe(audioAbs)
    const durationSec = round3(info?.durationSec)
    if (!(durationSec > 0.05)) {
      throw new Error(`Audio đoạn #${seg.index_num} không hợp lệ (duration = ${durationSec}) — retry từ stage script.tts`)
    }

    const startAtSec = round3(cursor)
    clips.push({
      id: uuidv4(),
      project_id: project.id,
      order_index: i,
      source_type: 'image',
      ref_id: asset.id,
      in_sec: 0,
      out_sec: durationSec,
      speed: 1,
      transition_in: null,
      transition_out: null,
      voice_audio_id: audio.id,
      start_at_sec: startAtSec,
    })
    cursor = round3(cursor + durationSec)
    setProgress(5 + Math.round(((i + 1) / segments.length) * 80))
  }

  await run('DELETE FROM timeline_clips WHERE project_id = ?', [project.id])
  await insertMany('timeline_clips', clips)

  const now = new Date().toISOString()
  for (let i = 0; i < segments.length; i++) {
    await run(
      `UPDATE script_segments SET duration_sec = ?, status = 'ready', updated_at = ? WHERE id = ? AND project_id = ?`,
      [clips[i].out_sec, now, segments[i].id, project.id]
    )
  }

  setProgress(98)
  return { clipCount: clips.length, totalDurationSec: round3(cursor) }
}

export default scriptAlign
