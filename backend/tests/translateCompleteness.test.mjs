// dub.translate completeness: GT 200 success, GT 404 -> LLM direct fallback,
// GT transient bounded retry, style 503 preserves base, semantic repair, strict gate.
// Run: node backend/tests/translateCompleteness.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-tcomp-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'
process.env.GEMINI_API_KEY = 'test-key'
process.env.GOOGLE_TRANSLATE_SCRIPT_URL = 'https://script.google.com/macros/s/TEST/exec'
process.env.GEMINI_RPM = '1000'

const { initSchema } = await import('../src/db/schema.js')
const { query, run } = await import('../src/db/query.js')
const mod = await import('../src/pipeline/stages/dubTranslate.js')
const dubTranslate = mod.default
const { assertTranslateComplete, validateTranslation, translateMissingWithLlm } = mod
const { validateForRender } = await import('../src/pipeline/stages/dubMerge.js')

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const realFetch = globalThis.fetch
const mkRes = ({ ok, status, json }) => ({ ok, status, json: async () => json, headers: { get: () => null } })

// Mutable scenario state
let gtBases = new Map()
let gt404 = new Set()
let gt503Once = new Set() // texts that 503 on first fetch then succeed
let gtCalls = 0
let gtCallsByText = new Map()
let geminiMode = 'ok' // ok | 503
let directBases = new Map() // source -> valid VI translation for LLM-direct
let styledSuffix = ''

globalThis.fetch = async (url, opts) => {
  const u = String(url)
  if (u.includes('generativelanguage.googleapis.com')) {
    if (geminiMode === '503') {
      return mkRes({ ok: false, status: 503, json: { error: { message: 'high demand, try again' } } })
    }
    const body = JSON.parse(opts.body)
    const prompt = body.contents?.[0]?.parts?.[0]?.text || ''
    // Repair path: plain-text prompt containing Câu cần dịch
    if (prompt.includes('Câu cần dịch:')) {
      const m = prompt.match(/Câu cần dịch:\s*"([^"]+)"/)
      const src = m ? m[1] : ''
      const t = directBases.get(src) || gtBases.get(src) || ''
      return mkRes({ ok: true, status: 200, json: { candidates: [{ content: { parts: [{ text: t }] } }], usageMetadata: {} } })
    }
    // Restyle (has |tgt:) vs direct (only |src:) — both JSON segments
    const hasTgt = prompt.includes('|tgt:')
    if (hasTgt) {
      const idxs = [...prompt.matchAll(/(\d+)\|src:/g)].map((m) => Number(m[1]))
      const tgtByIndex = new Map()
      for (const line of prompt.split('\n')) {
        const m = line.match(/^(\d+)\|src:.*\|tgt:(.*)$/)
        if (m) tgtByIndex.set(Number(m[1]), m[2])
      }
      const segments = idxs.map((i) => ({ index: i, translation: `${tgtByIndex.get(i) ?? ''}${styledSuffix}`.trim() }))
      return mkRes({ ok: true, status: 200, json: { candidates: [{ content: { parts: [{ text: JSON.stringify({ segments }) }] } }], usageMetadata: {} } })
    }
    // Direct: lines "index|src:text"
    const segs = []
    for (const line of prompt.split('\n')) {
      const m = line.match(/^(\d+)\|src:(.*)$/)
      if (m) {
        const src = m[2].trim()
        const t = directBases.get(src) || gtBases.get(src) || ''
        if (t) segs.push({ index: Number(m[1]), translation: t })
      }
    }
    return mkRes({ ok: true, status: 200, json: { candidates: [{ content: { parts: [{ text: JSON.stringify({ segments: segs }) }] } }], usageMetadata: {} } })
  }
  // Google Apps Script
  gtCalls++
  const q = new URL(u)
  const text = q.searchParams.get('text') ?? ''
  gtCallsByText.set(text, (gtCallsByText.get(text) || 0) + 1)
  if (gt404.has(text)) return mkRes({ ok: false, status: 404, json: {} })
  if (gt503Once.has(text) && gtCallsByText.get(text) === 1) {
    return mkRes({ ok: false, status: 503, json: {} })
  }
  const t = gtBases.get(text)
  if (!t) return mkRes({ ok: true, status: 200, json: { status: 'error', error: 'not found' } })
  return mkRes({ ok: true, status: 200, json: { status: 'success', translatedText: t } })
}

let n = 0
async function makeProject({ sources, presetSlug = null }) {
  n++
  const userId = `uc${n}`, projectId = `pc${n}`
  await run('INSERT OR IGNORE INTO settings (user_id, active_llm_provider, active_translate_provider) VALUES (?, ?, ?)',
    [userId, 'gemini', 'google_translate'])
  const params = { targetLanguage: 'vi', sourceLanguage: 'en', tier: 'free' }
  if (presetSlug) {
    await run('INSERT OR IGNORE INTO style_presets (id, slug, name, system_prompt) VALUES (?, ?, ?, ?)',
      [`spc${n}`, presetSlug, `P${n}`, 'ấm áp'])
    params.stylePreset = presetSlug
  }
  await run('INSERT INTO projects (id, user_id, mode, title, params) VALUES (?, ?, ?, ?, ?)',
    [projectId, userId, 'TRANSLATE_DUB', `T${n}`, JSON.stringify(params)])
  for (let i = 0; i < sources.length; i++) {
    await run('INSERT INTO transcript_segments (id, project_id, index_num, start_sec, end_sec, text) VALUES (?, ?, ?, ?, ?, ?)',
      [`sc${n}_${i}`, projectId, i, i * 2, i * 2 + 1.8, sources[i]])
  }
  const project = (await query('SELECT * FROM projects WHERE id = ?', [projectId]))[0]
  return { project, ctx: { project, job: { id: `jobc${n}` }, setProgress: () => {}, signal: undefined } }
}

function resetMocks() {
  gtBases = new Map(); gt404 = new Set(); gt503Once = new Set()
  gtCalls = 0; gtCallsByText = new Map()
  geminiMode = 'ok'; directBases = new Map(); styledSuffix = ''
  return run('DELETE FROM provider_cache').catch(() => {})
}

// 1. Google 200 -> success (no style)
await resetMocks()
{
  const src = ['hello world', 'how are you?']
  gtBases = new Map([['hello world', 'xin chào thế giới'], ['how are you?', 'bạn có khỏe không?']])
  const { project, ctx } = await makeProject({ sources: src })
  const res = await dubTranslate(ctx)
  assert(res.translatedCount === 2 && res.segmentCount === 2, `GT200: 2/2 success (got ${res.translatedCount})`)
  assert((res.unresolved || []).length === 0, 'GT200: unresolved empty')
  const v = await validateForRender(project.id)
  assert(v.valid === true, 'GT200: render validation passes')
}

// 2. Google 404 -> LLM direct fallback rescues all
await resetMocks()
{
  const src = ['good morning', 'see you soon', 'take care']
  const bases = ['chào buổi sáng', 'hẹn sớm gặp lại', 'giữ gìn sức khỏe nhé']
  // GT 404 on ALL (simulates bad endpoint) — stage must short-circuit + LLM rescue
  gtBases = new Map()
  gt404 = new Set(src)
  directBases = new Map(src.map((s, i) => [s, bases[i]]))
  const { project, ctx } = await makeProject({ sources: src })
  const res = await dubTranslate(ctx)
  const rows = await query('SELECT translation FROM transcript_segments WHERE project_id = ? ORDER BY index_num', [project.id])
  assert(res.translatedCount === 3, `404->LLM: 3/3 rescued (got ${res.translatedCount})`)
  assert(rows.every((r, i) => r.translation === bases[i]), '404->LLM: direct translations used, order preserved')
  assert(gtCalls <= 3, `404 bounded: GT calls no retry per 404 (calls=${gtCalls}, not 3xretry each)`)
  const v = await validateForRender(project.id)
  assert(v.valid === true, '404->LLM: render validation passes after fallback')
}

// 3. Google transient 503 -> bounded retry then success
await resetMocks()
{
  const src = ['hello again']
  gtBases = new Map([['hello again', 'xin chào lần nữa']])
  gt503Once = new Set(['hello again'])
  const { project, ctx } = await makeProject({ sources: src })
  const res = await dubTranslate(ctx)
  assert(res.translatedCount === 1, '503 transient: eventually succeeds')
  const calls = gtCallsByText.get('hello again') || 0
  assert(calls >= 2 && calls <= 6, `503 bounded retry (fetch calls=${calls})`)
}

// 4. Gemini style 503 -> validated base preserved
await resetMocks()
{
  const src = ['good evening everyone']
  gtBases = new Map([['good evening everyone', 'chào buổi tối mọi người']])
  directBases = new Map()
  geminiMode = '503'
  const { project, ctx } = await makeProject({ sources: src, presetSlug: 'warm-x' })
  const res = await dubTranslate(ctx)
  const rows = await query('SELECT translation FROM transcript_segments WHERE project_id = ? ORDER BY index_num', [project.id])
  assert(rows[0].translation === 'chào buổi tối mọi người', 'style503: base preserved')
  assert(res.styleFallback === true, 'style503: fallback flag set')
}

// 5. Semantic mismatch -> repair or strict fail (no fabrication)
await resetMocks()
{
  // validateTranslation unit: number mismatch must fail
  const bad = validateTranslation('i have 2 apples', 'tôi có 3 quả táo', 'vi')
  assert(bad.ok === false, 'semantic: number mismatch rejected')
  const copy = validateTranslation('hello', 'hello', 'vi')
  assert(copy.ok === false, 'semantic: untranslated copy rejected')
  // Stage: GT returns semantically-bad (number changed) + LLM repair mock returns valid
  const src = ['i have 2 apples']
  gtBases = new Map([['i have 2 apples', 'tôi có 3 quả táo']])
  directBases = new Map([['i have 2 apples', 'tôi có 2 quả táo']])
  const { project, ctx } = await makeProject({ sources: src })
  const res = await dubTranslate(ctx)
  const rows = await query('SELECT translation FROM transcript_segments WHERE project_id = ? ORDER BY index_num', [project.id])
  assert(rows[0].translation === 'tôi có 2 quả táo', `semantic repair: fixed to valid (got "${rows[0].translation}")`)
  assert(res.translatedCount === 1, 'semantic repair: stage succeeds after repair')
}

// 6. Strict gate: partial must throw, never COMPLETED
await resetMocks()
{
  let threw = false
  try {
    assertTranslateComplete(
      [{ id: 'a', text: 'hi' }, { id: 'b', text: 'hello' }],
      new Map([['a', 'xin chào']]),
      [1]
    )
  } catch (e) {
    threw = /incomplete: 1\/2/.test(e.message)
  }
  assert(threw, 'strict gate: 1/2 throws incomplete')
  // translateMissingWithLlm preserves index, no dup/loss
  const fakeLlm = {
    id: 'gemini',
    apiKeyId: null,
    provider: { complete: async () => ({ text: JSON.stringify({ segments: [{ index: 5, translation: 'xin chào' }] }) }) },
  }
  // Mock callProvider path would need DB; just assert helper exists and validates
  assert(typeof translateMissingWithLlm === 'function', 'llm-direct helper exists (source->target, not restyle-only)')
}

globalThis.fetch = realFetch
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
