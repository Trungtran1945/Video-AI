import path from 'path'
import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, updateById, insert, run } from '../../db/query.js'
import { getProvider } from '../../providers/registry.js'
import { tracked } from '../../providers/tracked.js'
import { projectDir, extractJsonBlock, round2 } from '../context.js'

const CONTEXT_WINDOW_SEC = 30 // docs/05 §B.4: gom ~30 giây thoại / lần gọi LLM

// dub.translate (docs/05 §B.4): Hybrid Google Translate + LLM restyle.
// Bước 1: Google Translate dịch sát nghĩa (accurate base translation).
// Bước 2: Nếu có style preset → LLM chỉ "viết lại" theo style (giữ nguyên nghĩa).
// Nếu không có style preset → dùng kết quả Google Translate trực tiếp.
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
  const sourceLanguage = params.sourceLanguage || 'auto'
  const hasStyle = !!preset?.system_prompt

  // Lấy Google Translate provider (keyless, dùng Apps Script URL)
  const gt = await getProvider(project.user_id, 'translate').catch(() => null)
  // LLM provider cho bước restyle (chỉ cần khi có style preset)
  const llm = hasStyle ? await getProvider(project.user_id, 'llm').catch(() => null) : null

  if (!gt) {
    throw new Error(
      'Không có Google Translate provider. Kiểm tra GOOGLE_TRANSLATE_SCRIPT_URL trong file .env'
    )
  }

  const system = buildSystemPrompt(preset, targetLanguage)
  setProgress(5)

  // BƯỚC 1: Google Translate — dịch sát nghĩa từng câu
  const gtResults = new Map() // index_num → bản dịch Google Translate
  const segmentsToTranslate = segments.filter((s) => s.text && s.text.trim())

  for (let i = 0; i < segmentsToTranslate.length; i++) {
    const seg = segmentsToTranslate[i]
    const text = (seg.text || '').trim()
    if (!text) continue
    try {
      const translated = await gt.provider.translate(text, sourceLanguage, targetLanguage)
      if (translated && translated !== text) {
        gtResults.set(seg.index_num, translated.trim())
      }
    } catch (err) {
      console.warn(`[dubTranslate] Google Translate lỗi segment #${seg.index_num}: ${err.message}`)
    }
    setProgress(5 + Math.round(((i + 1) / segmentsToTranslate.length) * 40))
  }

  if (!gtResults.size) throw new Error('Google Translate không trả về bản dịch hợp lệ nào')

  // BƯỚC 2: LLM restyle (chỉ khi có style preset VÀ có LLM)
  const translations = new Map() // segment id → bản dịch cuối cùng

  if (hasStyle && llm) {
    // Có style preset + có LLM → LLM viết lại theo style
    const restyleSystem = buildRestyleSystemPrompt(preset, targetLanguage)
    const groups = groupByWindow(segments, CONTEXT_WINDOW_SEC)
    let restyled = 0
    for (let g = 0; g < groups.length; g++) {
      const group = groups[g]
      const groupTranslations = []
      for (const seg of group) {
        const gtText = gtResults.get(seg.index_num)
        if (gtText) {
          groupTranslations.push({ index: seg.index_num, original: seg.text, translation: gtText })
        }
      }
      if (!groupTranslations.length) continue

      const restyledGroup = await restyleGroup(llm, restyleSystem, groupTranslations, preset, job, project.id)

      for (const seg of group) {
        const restyledText = restyledGroup.get(seg.index_num)
        if (restyledText) {
          await updateById('transcript_segments', seg.id, { translation: restyledText })
          translations.set(seg.id, restyledText)
          restyled++
        }
      }
      setProgress(45 + Math.round(((g + 1) / groups.length) * 45))
    }
    if (!restyled) throw new Error('LLM không trả về bản dịch restyle hợp lệ nào')
  } else {
    // Không có style preset HOẶC không có LLM → dùng Google Translate trực tiếp
    if (hasStyle && !llm) {
      console.warn('[dubTranslate] Có style preset nhưng thiếu LLM provider — dùng Google Translate trực tiếp')
    }
    for (const seg of segments) {
      const gtText = gtResults.get(seg.index_num)
      if (gtText) {
        await updateById('transcript_segments', seg.id, { translation: gtText })
        translations.set(seg.id, gtText)
      }
    }
    setProgress(90)
  }

  if (!translations.size) throw new Error('Không có bản dịch hợp lệ nào')

  // Sinh SRT từ timing gốc + bản dịch (docs/05 FR-T6)
  const cues = segments
    .filter((s) => translations.has(s.id))
    .map((s) => ({ start: Number(s.start_sec), end: Number(s.end_sec), text: translations.get(s.id) }))
  if (cues.length) await writeSrt(project, cues)

  return {
    translatedCount: translations.size,
    segmentCount: segments.length,
    presetSlug: preset?.slug || null,
    targetLanguage,
    method: hasStyle ? 'google_translate + llm_restyle' : 'google_translate',
  }
}

// LLM restyle: chỉ viết lại bản dịch đã chính xác theo style preset.
// KHÔNG dịch lại — giữ nguyên nghĩa, chỉ thay văn phong.
async function restyleGroup(llm, system, groupTranslations, preset, job, projectId) {
  const input = groupTranslations
    .map((t) => `${t.index}|${t.translation}`)
    .join('\n')

  const prompt =
    `Viết lại các câu lồng tiếng dưới đây theo phong cách: ${preset.name}.\n` +
    `Bản dịch gốc đã ĐÚNG NGHĨA — KHÔNG được thay đổi ý, chỉ thay đổi văn phong.\n` +
    `Mỗi dòng có định dạng "index|bản dịch". Giữ nguyên index, CHỈ viết lại phần bản dịch.\n\n` +
    `${input}\n\n` +
    `Trả về DUY NHẤT JSON: {"segments":[{"index":int,"translation":string}]}`

  const requiredIndexes = groupTranslations.map((t) => t.index)
  const estTokens = groupTranslations.reduce((n, t) => n + Math.max(8, Math.ceil((t.translation || '').length * 2.5)), 0) + 256
  const maxOutputTokens = Math.min(65536, Math.max(1024, Math.ceil(estTokens * 1.5)))

  const collected = new Map()
  const MAX_ATTEMPTS = 3
  let attempt = 0
  while (attempt < MAX_ATTEMPTS) {
    let p = prompt
    if (attempt > 0) {
      const missingNow = requiredIndexes.filter((i) => !collected.has(i))
      p = `${prompt}\n\nLƯU Ý: trả về ĐÚNG định dạng JSON. Các index SAU CHƯA được viết lại (bắt buộc phải có đủ): ${missingNow.join(', ')}.`
    }
    const call = (pp) =>
      tracked(
        { projectId, jobId: job.id, provider: llm.id, type: 'llm' },
        () => llm.provider.complete({ system, prompt: pp, json: true, temperature: 0.4, maxOutputTokens })
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

    const m = parseToMap(await call(p))
    for (const [idx, t] of m) if (!collected.has(idx)) collected.set(idx, t)

    const missingIndexes = requiredIndexes.filter((i) => !collected.has(i))
    if (!missingIndexes.length) break
    attempt++
  }
  return collected
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

// Giữ lại translateGroup làm fallback (nếu Google Translate lỗi)
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
    `Bạn là biên tập viên lồng tiếng chuyên nghiệp. Nhiệm vụ: viết lại câu lồng tiếng sang ${languageName(targetLanguage)}.` +
    ` Luôn giữ ý nghĩa gốc, không bịa thêm chi tiết.`
  if (preset?.system_prompt) return `${base} Văn phong bắt buộc — ${preset.name}: ${preset.system_prompt}`
  return `${base} Văn phong trung tính tự nhiên.`
}

function buildRestyleSystemPrompt(preset, targetLanguage) {
  const base =
    `Bạn là biên tập viên lồng tiếng chuyên nghiệp. Nhiệm vụ: VIẾT LẠI câu lồng tiếng đã được dịch sẵn sang ${languageName(targetLanguage)}.` +
    ` BẢN DỊCH GỐC ĐÃ ĐÚNG NGHĨA — bạn CHỈ thay đổi văn phong, KHÔNG được thay đổi ý nghĩa.` +
    ` KHÔNG thêm bớt nội dung, KHÔNG dịch lại từ đầu.`
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
