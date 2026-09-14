// Acceptance test: style preset is OPTIONAL — base translation must survive
// style-provider outage. Also: one failed GT segment must not corrupt others,
// and render validation must catch the unresolved segment.
// Run: node backend/tests/styleFallback.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-style-'))
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
const { default: dubTranslate, resolveFinalTranslation } = await import('../src/pipeline/stages/dubTranslate.js')
const { validateForRender } = await import('../src/pipeline/stages/dubMerge.js')

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// ── Pure seam: final-translation picker ──────────────────────────────
const pickOk = resolveFinalTranslation({
  source: 'good morning everyone', base: 'chào buổi sáng mọi người',
  styled: 'chào buổi sáng cả nhà', targetLanguage: 'vi',
})
assert(pickOk?.text === 'chào buổi sáng cả nhà' && pickOk?.via === 'styled', 'valid styled wins')

const pickBadStyle = resolveFinalTranslation({
  source: 'i have 2 apples', base: 'tôi có 2 quả táo',
  styled: 'tôi có 3 quả táo', targetLanguage: 'vi',
})
assert(pickBadStyle?.text === 'tôi có 2 quả táo' && pickBadStyle?.via === 'base', 'semantically-invalid styled rejected -> base')

const pickNone = resolveFinalTranslation({ source: 'hello', base: '', styled: '', targetLanguage: 'vi' })
assert(pickNone === null, 'no valid translation -> null (never fabricated)')

// ── Stage harness ────────────────────────────────────────────────────
const realFetch = globalThis.fetch
const mkRes = ({ ok, status, json }) => ({
  ok, status,
  json: async () => json,
  headers: { get: () => null },
})

// Mutable per-scenario behavior.
let geminiMode = 'ok' // 'ok' | '503' | 'invalid'
let gtBases = new Map() // source text -> base translation
let gt404 = new Set() // source texts that 404
let styledFor = (base) => base

globalThis.fetch = async (url, opts) => {
  const u = String(url)
  if (u.includes('generativelanguage.googleapis.com')) {
    if (geminiMode === '503') {
      return mkRes({ ok: false, status: 503, json: { error: { message: 'This model is currently experiencing high demand. Please try again later.' } } })
    }
    const body = JSON.parse(opts.body)
    const prompt = body.contents?.[0]?.parts?.[0]?.text || ''
    const idxs = [...prompt.matchAll(/(\d+)\|src:/g)].map((m) => Number(m[1]))
    const tgtByIndex = new Map()
    for (const line of prompt.split('\n')) {
      const m = line.match(/^(\d+)\|src:.*\|tgt:(.*)$/)
      if (m) tgtByIndex.set(Number(m[1]), m[2])
    }
    const segments = idxs.map((i) => ({ index: i, translation: styledFor(tgtByIndex.get(i) ?? '', i) }))
    return mkRes({
      ok: true, status: 200,
      json: { candidates: [{ content: { parts: [{ text: JSON.stringify({ segments }) }] } }], usageMetadata: {} },
    })
  }
  // Google Apps Script endpoint.
  const q = new URL(u)
  const text = q.searchParams.get('text') ?? ''
  if (gt404.has(text)) return mkRes({ ok: false, status: 404, json: {} })
  const t = gtBases.get(text)
  if (!t) return mkRes({ ok: true, status: 200, json: { status: 'error', error: 'not found' } })
  return mkRes({ ok: true, status: 200, json: { status: 'success', translatedText: t } })
}

let n = 0
async function makeProject({ sources, presetSlug }) {
  n++
  const userId = `u${n}`, projectId = `p${n}`
  await run('INSERT OR IGNORE INTO settings (user_id, active_llm_provider, active_translate_provider) VALUES (?, ?, ?)',
    [userId, 'gemini', 'google_translate'])
  await run('INSERT OR IGNORE INTO style_presets (id, slug, name, system_prompt) VALUES (?, ?, ?, ?)',
    [`sp${n}`, presetSlug, `Preset ${n}`, 'ấm áp, thân thiện'])
  await run('INSERT INTO projects (id, user_id, mode, title, params) VALUES (?, ?, ?, ?, ?)',
    [projectId, userId, 'TRANSLATE_DUB', `T${n}`,
      JSON.stringify({ stylePreset: presetSlug, targetLanguage: 'vi', sourceLanguage: 'en', tier: 'free' })])
  for (let i = 0; i < sources.length; i++) {
    await run(
      'INSERT INTO transcript_segments (id, project_id, index_num, start_sec, end_sec, text) VALUES (?, ?, ?, ?, ?, ?)',
      [`s${n}_${i}`, projectId, i, i * 2, i * 2 + 1.8, sources[i]])
  }
  const project = (await query('SELECT * FROM projects WHERE id = ?', [projectId]))[0]
  return { project, ctx: { project, job: { id: `job${n}` }, setProgress: () => {}, signal: undefined } }
}

const SOURCES = ['good morning everyone', 'how are you today?', 'she does not like rain']
const BASES = ['chào buổi sáng mọi người', 'hôm nay bạn có khỏe không?', 'cô ấy không thích mưa']
const STYLED = ['chào buổi sáng cả nhà', 'hôm nay của bạn thế nào?', 'cô ấy không thích mưa chút nào']

// Scenario 1: all providers healthy -> styled wins.
gtBases = new Map(SOURCES.map((s, i) => [s, BASES[i]]))
gt404 = new Set()
geminiMode = 'ok'
styledFor = (base) => STYLED[BASES.indexOf(base)] ?? base
{
  const { project, ctx } = await makeProject({ sources: SOURCES, presetSlug: 'warm-a' })
  const res = await dubTranslate(ctx)
  const rows = await query('SELECT translation FROM transcript_segments WHERE project_id = ? ORDER BY index_num', [project.id])
  assert(res.translatedCount === 3, `healthy: 3 translated (got ${res.translatedCount})`)
  assert(rows.every((r, i) => r.translation === STYLED[i]), 'healthy: styled translations used')
  assert(!res.styleFallback, 'healthy: no fallback flag')
}

// Scenario 2: Gemini 503 -> retry -> fallback to validated base, stage SUCCEEDS.
await run('DELETE FROM provider_cache')
gtBases = new Map(SOURCES.map((s, i) => [s, BASES[i]]))
gt404 = new Set()
geminiMode = '503'
{
  const { project, ctx } = await makeProject({ sources: SOURCES, presetSlug: 'warm-b' })
  const res = await dubTranslate(ctx)
  const rows = await query('SELECT translation FROM transcript_segments WHERE project_id = ? ORDER BY index_num', [project.id])
  assert(res.translatedCount === 3, `503: stage succeeds with 3 translations (got ${res.translatedCount})`)
  assert(rows.every((r, i) => r.translation === BASES[i]), '503: validated base translations preserved')
  assert(res.styleFallback === true, '503: fallback flag set')
}

// Scenario 3: Gemini returns semantically-invalid styled output -> base used.
await run('DELETE FROM provider_cache')
geminiMode = 'ok'
styledFor = () => 'tôi có 3 quả táo và thêm chuyện bịa đặt'
{
  const src = ['i have 2 apples']
  gtBases = new Map([['i have 2 apples', 'tôi có 2 quả táo']])
  gt404 = new Set()
  const { project, ctx } = await makeProject({ sources: src, presetSlug: 'warm-c' })
  const res = await dubTranslate(ctx)
  const rows = await query('SELECT translation FROM transcript_segments WHERE project_id = ? ORDER BY index_num', [project.id])
  assert(rows[0].translation === 'tôi có 2 quả táo', 'invalid styled rejected -> base kept')
  assert(res.translatedCount === 1, 'invalid styled: stage succeeds via base')
}

// Scenario 4: GT 404 on one segment -> others intact, segment unresolved,
// render validation blocks.
await run('DELETE FROM provider_cache')
geminiMode = 'ok'
{
  const src = [...SOURCES, 'this place is very beautiful', 'see you again soon', 'good night my friend', 'take care on your way']
  const bases = [...BASES, 'nơi này rất đẹp', 'hẹn sớm gặp lại bạn', 'chúc bạn ngủ ngon', 'đi đường cẩn thận nhé']
  gtBases = new Map(src.map((s, i) => [s, bases[i]]))
  gt404 = new Set(['this place is very beautiful'])
  styledFor = (base) => (/[?？]\s*$/.test(base) ? base : `${base} nhé`)
  const { project, ctx } = await makeProject({ sources: src, presetSlug: 'warm-d' })
  // styled output keeps meaning/numbers/negation/questions, so styled wins
  // wherever a base exists (fallback to base would still count as intact).
  const res = await dubTranslate(ctx)
  const rows = await query('SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY index_num', [project.id])
  const failed = rows.find((r) => r.text === 'this place is very beautiful')
  assert(failed && !failed.translation, '404 segment left unresolved (not fabricated)')
  assert(rows.filter((r) => r.translation).length === 6, `other 6 segments intact (got ${rows.filter((r) => r.translation).length})`)
  assert(res.translatedCount === 6, 'stage reports 6 translations')
  const v = await validateForRender(project.id)
  assert(v.valid === false && v.errors.some((e) => e.code === 'UNTRANSLATED_SEGMENTS'), 'render validation blocks unresolved segment')
}

globalThis.fetch = realFetch
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
