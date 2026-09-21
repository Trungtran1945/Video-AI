// Style-branch repair: khi base GT hard-fail gate mà styled cũng hỏng,
// dub.translate thử dịch lại 1 lần bằng LLM (bounded) thay vì unresolved ngay.
// - repair hợp lệ -> stage SUCCEEDS, dùng bản repair, styleFallback=true.
// - repair hỏng -> FAILED strict như cũ (không bịa bản dịch).
// - repair TRANSIENT (Gemini quá tải) -> bỏ qua lặng, giữ unresolved.
// Run: node backend/tests/styleRepair.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-stylerepair-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'
process.env.GEMINI_API_KEY = 'test-key'
process.env.GEMINI_MAX_RETRIES = '1'
process.env.GOOGLE_TRANSLATE_SCRIPT_URL = 'https://script.google.com/macros/s/TEST/exec'
process.env.GEMINI_RPM = '1000'

const { initSchema } = await import('../src/db/schema.js')
const { query, run } = await import('../src/db/query.js')
const { default: dubTranslate } = await import('../src/pipeline/stages/dubTranslate.js')

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const realFetch = globalThis.fetch
const mkRes = ({ ok, status, json }) => ({
  ok, status,
  json: async () => json,
  headers: { get: () => null },
})

let repairMode = 'ok' // 'ok' | 'invalid' | '503' | 'all503' | 'artifact'
let repairFor = 'tôi có 2 quả táo'

globalThis.fetch = async (url, opts) => {
  const u = String(url)
  if (u.includes('generativelanguage.googleapis.com')) {
    if (repairMode === 'all503') {
      return mkRes({ ok: false, status: 503, json: { error: { message: 'This model is currently experiencing high demand. Please try again later.' } } })
    }
    const body = JSON.parse(opts.body)
    const prompt = body.contents?.[0]?.parts?.[0]?.text || ''
    // Repair prompt là free-text ("Câu cần dịch:"), không có dòng index|src:.
    if (!prompt.includes('|src:')) {
      if (repairMode === '503') {
        return mkRes({ ok: false, status: 503, json: { error: { message: 'This model is currently experiencing high demand. Please try again later.' } } })
      }
      // Repair trả JSON artifact thô (LLM không tuân thủ "chỉ trả bản dịch").
      if (repairMode === 'artifact') {
        return mkRes({ ok: true, status: 200, json: { candidates: [{ content: { parts: [{ text: '{"segments":[]}' }] } }], usageMetadata: {} } })
      }
      const text = repairMode === 'invalid' ? 'tôi có 9 quả táo khổng lồ' : repairFor
      return mkRes({ ok: true, status: 200, json: { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} } })
    }
    // Restyle prompt: trả styled SAI số để ép cả base+styled đều hard-fail.
    const idxs = [...prompt.matchAll(/(\d+)\|src:/g)].map((m) => Number(m[1]))
    const segments = idxs.map((i) => ({ index: i, translation: 'tôi có 5 quả táo rực rỡ' }))
    return mkRes({
      ok: true, status: 200,
      json: { candidates: [{ content: { parts: [{ text: JSON.stringify({ segments }) }] } }], usageMetadata: {} },
    })
  }
  // Google Apps Script: base SAI số (number mismatch HARD), trừ câu tốt.
  const q = new URL(u)
  const goodBase = new Map([['good morning everyone', 'chào buổi sáng mọi người']])
  if (goodBase.has(q.searchParams.get('text') ?? '')) {
    return mkRes({ ok: true, status: 200, json: { status: 'success', translatedText: goodBase.get(q.searchParams.get('text')) } })
  }
  return mkRes({ ok: true, status: 200, json: { status: 'success', translatedText: 'tôi có 3 quả táo' } })
}

let n = 0
async function makeProject(sources = ['i have 2 apples']) {
  n++
  const userId = `ur${n}`, projectId = `pr${n}`
  await run('INSERT OR IGNORE INTO settings (user_id, active_llm_provider, active_translate_provider) VALUES (?, ?, ?)',
    [userId, 'gemini', 'google_translate'])
  await run('INSERT OR IGNORE INTO style_presets (id, slug, name, system_prompt) VALUES (?, ?, ?, ?)',
    [`spr${n}`, `repair-${n}`, `Preset ${n}`, 'ấm áp, thân thiện'])
  await run('INSERT INTO projects (id, user_id, mode, title, params) VALUES (?, ?, ?, ?, ?)',
    [projectId, userId, 'TRANSLATE_DUB', `R${n}`,
      JSON.stringify({ stylePreset: `repair-${n}`, targetLanguage: 'vi', sourceLanguage: 'en', tier: 'free', enableDubbing: true })])
  for (let i = 0; i < sources.length; i++) {
    await run(
      'INSERT INTO transcript_segments (id, project_id, index_num, start_sec, end_sec, text) VALUES (?, ?, ?, ?, ?, ?)',
      [`sr${n}_${i}`, projectId, i, i * 2, i * 2 + 1.8, sources[i]])
  }
  const project = (await query('SELECT * FROM projects WHERE id = ?', [projectId]))[0]
  return { project, ctx: { project, job: { id: `rjob${n}` }, setProgress: () => {}, signal: undefined } }
}

// A. repair hợp lệ -> stage SUCCEEDS bằng bản repair.
await run('DELETE FROM provider_cache')
repairMode = 'ok'
{
  const { project, ctx } = await makeProject()
  const res = await dubTranslate(ctx)
  const rows = await query('SELECT translation FROM transcript_segments WHERE project_id = ?', [project.id])
  assert(res.translatedCount === 1, `repair-ok: 1 translated (got ${res.translatedCount})`)
  assert(rows[0].translation === 'tôi có 2 quả táo', `repair-ok: dùng bản repair hợp lệ (got: ${rows[0].translation})`)
  assert(res.styleFallback === true, 'repair-ok: styleFallback=true (không phải styled)')
}

// B. repair cũng hỏng gate -> FAILED strict, không bịa.
await run('DELETE FROM provider_cache')
repairMode = 'invalid'
{
  const { project, ctx } = await makeProject()
  let threw = null
  try {
    await dubTranslate(ctx)
  } catch (e) {
    threw = e
  }
  const rows = await query('SELECT translation FROM transcript_segments WHERE project_id = ?', [project.id])
  assert(threw && /TRANSLATE_NEEDS_REVIEW:/.test(threw.message), 'repair-invalid: FAILED strict')
  assert(threw && /unresolved: 0/.test(threw.message), 'repair-invalid: liệt kê unresolved')
  assert(!rows[0].translation, 'repair-invalid: không ghi bản dịch hỏng')
}

// C. repair TRANSIENT (Gemini quá tải như incident) -> bỏ qua, giữ unresolved.
await run('DELETE FROM provider_cache')
repairMode = '503'
{
  const { project, ctx } = await makeProject()
  let threw = null
  try {
    await dubTranslate(ctx)
  } catch (e) {
    threw = e
  }
  assert(threw && /TRANSLATE_NEEDS_REVIEW:/.test(threw.message), 'repair-503: FAILED strict (không treo, không retry vô hạn)')
  assert(threw && /PATCH/.test(threw.message), 'repair-503: message giữ hướng dẫn sửa tay')
}

// D. restyle outage toàn phần (styled rỗng) + base hard-fail + repair 503
// (đúng shape incident) -> message có hint quá tải để phân biệt lỗi dữ liệu.
await run('DELETE FROM provider_cache')
repairMode = 'all503'
{
  const { project, ctx } = await makeProject(['i have 2 apples', 'good morning everyone'])
  let threw = null
  try {
    await dubTranslate(ctx)
  } catch (e) {
    threw = e
  }
  assert(threw && /TRANSLATE_NEEDS_REVIEW:/.test(threw.message), 'restyle-down: FAILED strict')
  assert(threw && /quá tải/.test(threw.message), 'restyle-down: message báo LLM restyle quá tải')
  assert(threw && /unresolved: 0/.test(threw.message), 'restyle-down: vẫn liệt kê unresolved')
}

// E. repair trả JSON artifact ("{"segments":[]}") -> từ chối, không ghi DB.
await run('DELETE FROM provider_cache')
repairMode = 'artifact'
{
  const { project, ctx } = await makeProject()
  let threw = null
  try {
    await dubTranslate(ctx)
  } catch (e) {
    threw = e
  }
  const rows = await query('SELECT translation FROM transcript_segments WHERE project_id = ?', [project.id])
  assert(threw && /TRANSLATE_NEEDS_REVIEW:/.test(threw.message), 'repair-artifact: FAILED strict')
  assert(!rows[0].translation, 'repair-artifact: không ghi JSON artifact vào DB')
}

globalThis.fetch = realFetch
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
