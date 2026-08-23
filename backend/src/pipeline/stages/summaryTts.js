import fs from 'node:fs'
import { query } from '../../db/query.js'
import { resolveStorageKey } from '../context.js'

export async function summaryTts(ctx) {
  const { project } = ctx
  const segments = await query(
    'SELECT id, voice_audio_id FROM script_segments WHERE project_id = ? ORDER BY index_num ASC',
    [project.id]
  )
  if (!segments.length) {
    throw new Error('Chưa có kịch bản — hãy retry từ stage summary.script')
  }
  const audios = await query('SELECT * FROM audios WHERE project_id = ?', [project.id])
  const byId = new Map(audios.map((a) => [a.id, a]))

  for (const seg of segments) {
    const audio = seg.voice_audio_id ? byId.get(seg.voice_audio_id) : null
    if (!audio) throw new Error(`Thiếu bản ghi âm cho segment — hãy retry từ stage summary.align`)
    const abs = resolveStorageKey(audio.storage_key)
    if (!abs || !fs.existsSync(abs)) {
      throw new Error(`Tệp giọng đọc thiếu trên đĩa (${audio.storage_key}) — retry từ stage summary.align`)
    }
  }

  return { audioCount: audios.filter((a) => a.kind === 'voice').length }
}

export default summaryTts
