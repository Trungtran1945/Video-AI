// GT-fallback regression: LLM returns nothing → Google Translate covers what
// it can, GT-404 segment lands in TRANSLATE_NEEDS_REVIEW quarantine.
// Run: node tests/translateFallback.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-fallback-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.GEMINI_API_KEY = 'test-key'
process.env.GEMINI_RPM = '1000'
process.env.GOOGLE_TRANSLATE_SCRIPT_URL = 'https://script.google.com/macros/s/TEST/exec'

const { initSchema } = await import('../src/db/schema.js')
const { query, run } = await import('../src/db/query.js')
const { default: dubTranslate } = await import('../src/pipeline/stages/dubTranslate.js')

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const realFetch = globalThis.fetch
const mkRes = ({ ok, status, json }) => ({ ok, status, json: async () => json, headers: { get: () => null } })

const SOURCES = ['hello world', 'good morning', 'see you later', 'have fun']
const BASES = ['xin chào thế giới', 'chào buổi sáng', 'hẹn gặp lại', 'chúc vui vẻ']

globalThis.fetch = async (url) => {
  const u = String(url)
  // LLM returns empty batches (outage shape) — never throws, resolves fast.
  if (u.includes('generativelanguage.googleapis.com')) {
    return mkRes({ ok: true, status: 200, json: { candidates: [{ content: { parts: [{ text: JSON.stringify({ segments: [] }) }] } }], usageMetadata: {} } })
  }
  const q = new URL(u)
  const text = q.searchParams.get('text') ?? ''
  const idx = SOURCES.indexOf(text)
  if (idx === 2) return mkRes({ ok: false, status: 404, json: {} }) // GT 404 on one segment
  if (idx >= 0) return mkRes({ ok: true, status: 200, json: { status: 'success', translatedText: BASES[idx] } })
  return mkRes({ ok: true, status: 200, json: { status: 'error', error: 'not found' } })
}

const userId = 'ufb', projectId = 'pfb'
await run('INSERT OR IGNORE INTO settings (user_id, active_llm_provider, active_translate_provider) VALUES (?, ?, ?)',
  [userId, 'gemini', 'google_translate'])
await run('INSERT INTO projects (id, user_id, mode, title, params) VALUES (?, ?, ?, ?, ?)',
  [projectId, userId, 'TRANSLATE_DUB', 'FB', JSON.stringify({ targetLanguage: 'vi', sourceLanguage: 'en', enableDubbing: false })])
for (let i = 0; i < SOURCES.length; i++) {
  await run('INSERT INTO transcript_segments (id, project_id, index_num, start_sec, end_sec, text) VALUES (?, ?, ?, ?, ?, ?)',
    [`fb_seg_${i}`, projectId, i, i * 2, i * 2 + 1.8, SOURCES[i]])
}

const project = (await query('SELECT * FROM projects WHERE id = ?', [projectId]))[0]
let err = null
try {
  await dubTranslate({ project, job: { id: 'jobfb' }, setProgress: () => {}, signal: undefined })
} catch (e) { err = e }
assert(err && String(err.message).startsWith('TRANSLATE_NEEDS_REVIEW'), 'GT-404 segment fails stage with NEEDS_REVIEW')
assert(err && String(err.message).includes('unresolved: 2'), `quarantine names segment 2 (got: ${String(err?.message).slice(0, 120)})`)
const rows = await query('SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC', [projectId])
assert(rows.filter((r) => r.translation === BASES[rows.indexOf(r)]).length === 0 || rows[0].translation === BASES[0], 'GT fallback translations persisted for reachable segments')
assert(rows[0].translation === BASES[0] && rows[1].translation === BASES[1] && rows[3].translation === BASES[3], 'GT fallback covers 3/4, 404 left unresolved')

globalThis.fetch = realFetch
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
