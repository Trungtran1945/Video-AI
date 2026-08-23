import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { query } from '../../db/query.js'
import { getProvider } from '../../providers/registry.js'
import { tracked } from '../../providers/tracked.js'
import { projectDir, readJson, extractJsonBlock, clamp, parseJsonSafe, insertMany } from '../context.js'

const SYSTEM_PROMPT =
  'Bạn là biên kịch review phim chuyên nghiệp. Luôn trả về DUY NHẤT một JSON hợp lệ theo đúng schema được yêu cầu, không thêm giải thích.'

function buildPrompt({ transcriptText, sceneLines, targetDurationSec, language, tone, spoilerAllowed }) {
  return [
    `Hãy viết kịch bản review phim bằng tiếng ${language} với giọng điệu ${tone || 'hấp dẫn, tự nhiên'}.`,
    spoilerAllowed ? 'Được phép tiết lộ nội dung quan trọng (spoiler).' : 'KHÔNG tiết lộ twist/cuối phim (chống spoiler).',
    '',
    'TRANSKRIPT PHIM (tóm lược):',
    transcriptText,
    '',
    'DANH SÁCH CẢNH KHÁU CHÌA (chỉ được dùng các id này):',
    sceneLines.join('\n'),
    '',
    'YÊU CẦU:',
    `- Tổng targetDurationSec của tất cả segment xấp xỉ ${targetDurationSec} giây.`,
    '- Mỗi segment dài 30-90 giây, có lời review (narration) tự nhiên, mạch lạc.',
    '- Mỗi segment tham chiếu 1-4 cảnh phù hợp với nội dung lời review (sceneRefs), ưu tiên phân bố đều theo thời lượng phim.',
    '- Chỉ chọn scene từ danh sách, không bịa id mới.',
    '',
    'Trả JSON đúng schema:',
    '{"segments":[{"narration":"...","targetDurationSec":45,"sceneRefs":[{"sceneId":"...","weight":0.8}]}]}',
  ].join('\n')
}

function digestTranscript(segments) {
  const text = segments.map((s) => s.text).join(' ')
  if (text.length <= 14000) return text
  const head = Math.floor(text.length * 0.55)
  return text.slice(0, head) + '\n[...phần giữa đã lược bớt...]\n' + text.slice(text.length - (14000 - head))
}

export async function summaryScript(ctx) {
  const { project, job, setProgress } = ctx
  const transcript = readJson(path.join(projectDir(project.id), 'transcript.json'))
  if (!transcript?.segments?.length) {
    throw new Error('Chưa có transcript — hãy retry từ stage summary.transcribe')
  }

  const allScenes = await query('SELECT * FROM scenes WHERE project_id = ? ORDER BY start_sec ASC', [project.id])
  const described = allScenes.filter((s) => s.description)
  if (!described.length) {
    throw new Error('Chưa có mô tả cảnh nào — hãy retry từ stage summary.analyze')
  }
  const knownIds = new Set(allScenes.map((s) => s.id))
  setProgress(8)

  const params = parseJsonSafe(project.params, {}) || {}
  const targetDurationSec = clamp(Number(project.target_duration_sec) || 1500, 300, 3600)
  const prompt = buildPrompt({
    transcriptText: digestTranscript(transcript.segments),
    sceneLines: described
      .slice(0, 60)
      .map((s) => `[${s.id}] ${Math.round(s.start_sec)}-${Math.round(s.end_sec)}s: ${s.description}`),
    targetDurationSec,
    language: project.language === 'en' ? 'Anh' : 'Việt',
    tone: params.tone,
    spoilerAllowed: Boolean(params.spoilerAllowed),
  })

  const llm = await getProvider(project.user_id, 'llm')
  const res = await tracked(
    { projectId: project.id, jobId: job.id, provider: llm.id, type: 'llm' },
    () => llm.provider.complete({ system: SYSTEM_PROMPT, prompt, json: true, maxOutputTokens: 8000 })
  )
  setProgress(70)

  const parsed = extractJsonBlock(res.text)
  const rawSegments = Array.isArray(parsed?.segments) ? parsed.segments : []
  const valid = []
  for (const seg of rawSegments) {
    const narration = String(seg?.narration || '').trim()
    if (!narration) continue
    const refs = Array.isArray(seg?.sceneRefs)
      ? seg.sceneRefs
          .filter((r) => r && knownIds.has(r.sceneId))
          .map((r) => ({ sceneId: r.sceneId, weight: Number(r.weight) > 0 ? Number(r.weight) : 0.6 }))
      : []
    if (!refs.length) continue
    valid.push({
      narration: narration.slice(0, 2000),
      targetDurationSec: clamp(Number(seg.targetDurationSec) || 45, 15, 180),
      refs,
    })
  }
  if (!valid.length) {
    throw new Error('LLM trả về kịch bản không hợp lệ (không có segment nào tham chiếu cảnh có thật). Thử Regenerate.')
  }

  const totalTarget = valid.reduce((a, s) => a + s.targetDurationSec, 0)
  const factor = totalTarget > 0 ? targetDurationSec / totalTarget : 1
  const rows = valid.map((seg, i) => ({
    id: uuidv4(),
    project_id: project.id,
    index_num: i,
    narration: seg.narration,
    target_duration_sec: clamp(Math.round(seg.targetDurationSec * factor), 10, 300),
    scene_refs: JSON.stringify(seg.refs),
    voice_audio_id: null,
    subtitle_id: null,
  }))
  await insertMany('script_segments', rows)
  setProgress(98)

  return { segmentCount: rows.length, totalTargetSec: rows.reduce((a, s) => a + s.target_duration_sec, 0) }
}

export default summaryScript
