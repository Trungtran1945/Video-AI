import path from 'path'
import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, updateById, insert, run } from '../../db/query.js'
import { getProvider } from '../../providers/registry.js'
import { tracked } from '../../providers/tracked.js'
import { projectDir, extractJsonBlock, round2 } from '../context.js'

const CONTEXT_WINDOW_SEC = 30 // docs/05 §B.4: gom ~30 giây thoại / lần gọi LLM

// dub.translate (docs/05 §B.4): LLM dịch theo StylePreset + context window.
export async function dubTranslate(ctx) {
  const { project, job, setProgress } = ctx
  const params = parseParams(project.params)

  const segments = await query(
    'SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC',
    [project.id]
  )
  if (!segments.length) throw new Error('Không có transcript để dịch — stage dub.stt chưa chạy hoặc rỗng')

  const presetSlug = params.stylePreset
  const preset = presetSlug
    ? await queryOne('SELECT * FROM style_presets WHERE slug = ?', [presetSlug])
    : null

  const targetLanguage = params.targetLanguage || 'vi'
  const llm = await getProvider(project.user_id, 'llm')
  const system = buildSystemPrompt(preset, targetLanguage)
  setProgress(5)

  // Gom nhóm theo context window ~30s (docs/05 §B.4)
  const groups = groupByWindow(segments, CONTEXT_WINDOW_SEC)
  let translated = 0
  const translations = new Map() // segment id → bản dịch
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]
    const lines = group
      .map((s) => `${s.index_num}|${round2(s.start_sec)}-${round2(s.end_sec)}|${s.text}`)
      .join('\n')
    const prompt =
      `Dịch các câu thoại dưới đây sang ${languageName(targetLanguage)}. ` +
      `Mỗi dòng có định dạng "index|thời gian|văn bản". ` +
      `Giữ nguyên index, CHỈ dịch phần văn bản, tuyệt đối không dịch phần index/thời gian. ` +
      `Yêu cầu: (1) DỊCH SÁT NGHĨA gốc, không bịa thêm thắt, không bỏ sót ý; ` +
      `(2) giữ nguyên tên riêng, địa danh, số liệu; (3) tự nhiên như lồng tiếng. ` +
      `Đừng so sánh độ dài — stage sau sẽ tự căn chỉnh thời lượng.\n\n${lines}\n\n` +
      `Trả về DUY NHẤT JSON: {"segments":[{"index":int,"translation":string}]}`

    // Ước lượng maxOutputTokens theo dung lượng nhóm để tránh JSON bị cắt ngắn
    // (nguyên nhân "chỉ dịch được vài câu"). 1 ký tự ~1 token, nhân hệ số an toàn.
    const estTokens = group.reduce((n, s) => n + Math.max(8, Math.ceil((s.text || '').length * 2.5)), 0) + 256
    const maxOutputTokens = Math.min(65536, Math.max(1024, Math.ceil(estTokens * 1.5)))
    // Chỉ yêu cầu dịch những câu có nội dung (bỏ qua câu rỗng).
    const requiredIndexes = group.filter((s) => s.text && s.text.trim()).map((s) => s.index_num)

    // Gọi LLM, tự động bù các index bị thiếu (docs/05 §B.4).
    const collected = await translateGroup(llm, system, prompt, job, project.id, {
      requiredIndexes,
      maxOutputTokens,
    })

    const map = new Map()
    for (const [idx, t] of collected) {
      const seg = group.find((s) => s.index_num === idx)
      if (!seg) continue
      const tt = String(t).trim()
      // Bỏ qua bản dịch rỗng hoặc trùng nguyên gốc (LLM không dịch được)
      if (tt && tt !== (seg.text || '').trim()) map.set(idx, tt)
    }

    for (const seg of group) {
      const translation = map.get(seg.index_num)
      if (!translation) continue
      await updateById('transcript_segments', seg.id, { translation })
      translations.set(seg.id, translation)
      translated++
    }
    setProgress(5 + Math.round(((g + 1) / groups.length) * 85))
  }

  if (!translated) throw new Error('LLM không trả về bản dịch hợp lệ nào')

  // Sinh SRT từ timing gốc + bản dịch (docs/05 FR-T6)
  const cues = segments
    .filter((s) => translations.has(s.id))
    .map((s) => ({ start: Number(s.start_sec), end: Number(s.end_sec), text: translations.get(s.id) }))
  if (cues.length) await writeSrt(project, cues)

  return {
    translatedCount: translated,
    segmentCount: segments.length,
    presetSlug: preset?.slug || null,
    targetLanguage,
  }
}

async function writeSrt(project, cues) {
  if (!cues.length) return
  const dir = projectDir(project.id)
  fs.mkdirSync(dir, { recursive: true })
  const srtPath = path.join(dir, 'subtitles.srt')
  const body = cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join('\n')
  fs.writeFileSync(srtPath, body, 'utf8')

  await run(`DELETE FROM subtitles WHERE project_id = ?`, [project.id])
  await insert('subtitles', {
    id: uuidv4(),
    project_id: project.id,
    format: 'srt',
    language: parseParams(project.params).targetLanguage || 'vi',
    storage_key: null,
    cues: JSON.stringify(cues),
  })
}

// Gọi LLM dịch 1 nhóm, parse JSON bền vững (bỏ code fence ```json), và tự động
// bù các index bị thiếu (JSON bị cắt ngắn do truncation → chỉ trả về vài câu đầu).
// Trả về Map(index_num → bản dịch). docs/05 §B.4.
export async function translateGroup(llm, system, prompt, job, projectId, opts = {}) {
  const { requiredIndexes = null, maxOutputTokens = null } = opts
  const call = (p) =>
    tracked(
      { projectId, jobId: job.id, provider: llm.id, type: 'llm' },
      () => llm.provider.complete({ system, prompt: p, json: true, temperature: 0.4, maxOutputTokens })
    )

  const sanitize = (text) =>
    String(text || '')
      .replace(/^[\s\S]*?```(?:json)?\s*/i, '')
      .replace(/```[\s\S]*$/, '')
      .trim()

  const parseToMap = (res) => {
    const parsed = extractJsonBlock(sanitize(res.text)) || {}
    const list = Array.isArray(parsed.segments) ? parsed.segments : []
    const m = new Map()
    for (const item of list) {
      if (item && Number.isInteger(item.index) && typeof item.translation === 'string') {
        const t = item.translation.trim()
        if (t) m.set(item.index, t)
      }
    }
    return m
  }

  const collected = new Map()
  const MAX_ATTEMPTS = 3
  let attempt = 0
  while (attempt < MAX_ATTEMPTS) {
    let p = prompt
    if (attempt > 0) {
      const missingNow = requiredIndexes.filter((i) => !collected.has(i))
      p = `${prompt}\n\nLƯU Ý: trả về ĐÚNG định dạng JSON. Các index SAU CHƯA được dịch (bắt buộc phải có đủ): ${missingNow.join(', ')}.`
    }
    const m = parseToMap(await call(p))
    for (const [idx, t] of m) if (!collected.has(idx)) collected.set(idx, t)
    if (!requiredIndexes) break
    const missingIndexes = requiredIndexes.filter((i) => !collected.has(i))
    if (!missingIndexes.length) break
    attempt++
  }
  return collected
}

function buildSystemPrompt(preset, targetLanguage) {
  const base =
    `Bạn là biên tập viên lồng tiếng chuyên nghiệp. Nhiệm vụ: dịch thoại video sang ${languageName(targetLanguage)}.` +
    ` Luôn giữ ý nghĩa gốc, không bịa thêm chi tiết.`
  if (preset?.system_prompt) return `${base} Văn phong bắt buộc — ${preset.name}: ${preset.system_prompt}`
  return `${base} Văn phong trung tính tự nhiên.`
}

function groupByWindow(segments, windowSec) {
  const groups = []
  let current = []
  let windowStart = 0
  for (const s of segments) {
    if (!current.length) windowStart = Number(s.start_sec) || 0
    if ((Number(s.end_sec) - windowStart) > windowSec && current.length) {
      groups.push(current)
      current = [s]
      windowStart = Number(s.start_sec) || 0
    } else {
      current.push(s)
    }
  }
  if (current.length) groups.push(current)
  return groups
}

function parseParams(raw) {
  try { return raw ? JSON.parse(raw) : {} } catch (_) { return {} }
}

function languageName(code) {
  const names = { vi: 'tiếng Việt', en: 'tiếng Anh' }
  return names[code] || code
}

function srtTime(sec) {
  const total = Math.max(0, Math.round(sec * 1000))
  const ms = total % 1000
  const s = Math.floor(total / 1000) % 60
  const m = Math.floor(total / 60000) % 60
  const h = Math.floor(total / 3600000)
  const p2 = (n) => String(n).padStart(2, '0')
  const p3 = (n) => String(n).padStart(3, '0')
  return `${p2(h)}:${p2(m)}:${p2(s)},${p3(ms)}`
}

export default dubTranslate
