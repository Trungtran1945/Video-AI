import { v4 as uuidv4 } from 'uuid'
import { query } from '../../db/query.js'
import { TRANSITION_DURATION } from '../alignService.js'
import { clamp, round2, insertMany } from '../context.js'

function interleaveByKind(assets) {
  const lower = (a) => String(a.kind || '').toLowerCase()
  const images = assets.filter((a) => lower(a) === 'image')
  const videos = assets.filter((a) => lower(a) === 'video')
  const rest = assets.filter((a) => lower(a) !== 'image' && lower(a) !== 'video')
  const mixed = []
  const maxLen = Math.max(images.length, videos.length)
  for (let i = 0; i < maxLen; i++) {
    if (images[i]) mixed.push(images[i])
    if (videos[i]) mixed.push(videos[i])
  }
  return mixed.length ? mixed : [...assets, ...rest]
}

export async function styleStoryboard(ctx) {
  const { project, job, setProgress } = ctx
  const assets = await query('SELECT * FROM assets WHERE project_id = ?', [project.id])
  const visualAssets = assets.filter((a) => ['image', 'video'].includes(String(a.kind || '').toLowerCase()))
  if (!visualAssets.length) {
    throw new Error('Không có ảnh/video nào trong dự án — hãy tạo lại dự án với assets đã upload')
  }

  const analyzeResult = ctx.results?.['style.analyze'] || {}
  const styleProfile = analyzeResult.styleProfile || {}
  const avgShotLen = clamp(Number(styleProfile?.pacing?.avgShotLen) || 2.2, 0.8, 5)
  const targetDurationSec = clamp(Number(project.target_duration_sec) || 45, 10, 120)
  setProgress(15)

  let ordered = visualAssets
  const llm = await getProviderSafe(project.user_id)
  if (llm && visualAssets.length >= 3) {
    try {
      const res = await llm.provider.complete({
        system: 'Bạn là đạo diễn video ngắn. Trả về DUY NHẤT JSON hợp lệ.',
        prompt: [
          `Sắp xếp thứ tự các asset sau thành storyboard ${targetDurationSec}s hấp dẫn (mở đầu mạnh, giữ nhịp).`,
          'Assets:',
          ...visualAssets.map((a) => `- id=${a.id} kind=${a.kind} dur=${a.duration_sec || 'anh'} key=${a.storage_key}`),
          'Trả JSON: {"order":["<assetId>",...]} — mỗi id xuất hiện đúng một lần.',
        ].join('\n'),
        json: true,
      })
      const parsed = JSON.parse(res.text.replace(/```(?:json)?|```/g, '').trim())
      if (Array.isArray(parsed.order)) {
        const byId = new Map(visualAssets.map((a) => [a.id, a]))
        const reordered = parsed.order.map((id) => byId.get(id)).filter(Boolean)
        const seen = new Set(reordered.map((a) => a.id))
        ordered = [...reordered, ...visualAssets.filter((a) => !seen.has(a.id))]
      }
    } catch (_) {
      ordered = visualAssets
    }
  }
  ordered = interleaveByKind(ordered)
  setProgress(55)

  const rows = []
  let cursor = 0
  let pass = 0
  while (cursor < targetDurationSec - 0.4 && pass < 8) {
    for (const asset of ordered) {
      const remaining = targetDurationSec - cursor
      if (remaining <= 0.4) break
      let shotLen = clamp(avgShotLen, 1, Math.min(4, remaining))
      let inSec = 0
      let outSec = shotLen
      if (String(asset.kind || '').toLowerCase() === 'video' && asset.duration_sec) {
        const maxStart = Math.max(0, Number(asset.duration_sec) - shotLen - 0.1)
        inSec = round2(Math.min(maxStart, ((rows.length * 1.7) % (maxStart + 0.01))))
        outSec = round2(inSec + shotLen)
      }
      rows.push({
        id: uuidv4(),
        project_id: project.id,
        order_index: rows.length,
        source_type: 'ASSET',
        ref_id: asset.id,
        in_sec: inSec,
        out_sec: outSec,
        speed: 1,
        transition_in: rows.length === 0 ? null : styleProfile?.transitions?.default || 'cross',
        transition_out: null,
        voice_audio_id: null,
        start_at_sec: round2(cursor),
      })
      cursor += shotLen - (rows.length > 1 ? TRANSITION_DURATION : 0)
      if (cursor < 0) cursor = 0
    }
    pass++
  }

  if (!rows.length) throw new Error('Không dựng được storyboard từ assets')
  const lastRow = rows[rows.length - 1]
  lastRow.transition_out = null
  await insertMany('timeline_clips', rows)
  setProgress(96)

  return { shotCount: rows.length, plannedDurationSec: round2(cursor), llmOrdered: Boolean(llm) }
}

async function getProviderSafe(userId) {
  try {
    const mod = await import('../../providers/registry.js')
    return await mod.getProvider(userId, 'llm')
  } catch (_) {
    return null
  }
}

export default styleStoryboard
