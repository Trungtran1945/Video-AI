// TransFlow-inspired XML-tagged segment translation prompt (Rule 2).
// One-to-one numbered batches: every <line id> must come back with exactly
// one translation — never move/merge/split/skip. <previous_lines> travel as
// context-only for pronouns/register continuity. <glossary> is obeyed strictly.
// Pure module (no I/O) — safe for unit tests.
const LANGUAGE_DESCRIPTIONS = {
  vi: ['Vietnamese', 'tiếng Việt'],
  en: ['English', null],
  zh: ['Chinese', '中文'],
  'zh-CN': ['Simplified Chinese', '简体中文'],
  'zh-TW': ['Traditional Chinese', '繁體中文'],
  ja: ['Japanese', '日本語'],
  ko: ['Korean', '한국어'],
  fr: ['French', 'français'],
  de: ['German', 'Deutsch'],
  es: ['Spanish', 'español'],
}

export function languageLabel(code) {
  const raw = String(code || '').trim()
  if (!raw) return 'Vietnamese (tiếng Việt, code: vi)'
  const primary = raw.toLowerCase().replace('_', '-').split('-', 1)[0]
  // Prefer full-code entry (zh-CN/zh-TW) when present.
  const full = LANGUAGE_DESCRIPTIONS[raw] || LANGUAGE_DESCRIPTIONS[raw.toLowerCase()]
  const desc = full || LANGUAGE_DESCRIPTIONS[primary]
  if (!desc) return raw
  const [name, native] = desc
  return native ? `${name} (${native}, code: ${raw})` : `${name} (code: ${raw})`
}

export function xmlEscape(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function glossaryBlock(glossary) {
  const terms = Array.isArray(glossary) ? glossary.filter((t) => t?.source && t?.target) : []
  if (!terms.length) return ''
  const lines = ['<glossary>']
  for (const t of terms) {
    const note = t.note ? ` note="${xmlEscape(t.note)}"` : ''
    lines.push(
      `  <term source="${xmlEscape(t.source)}" target="${xmlEscape(t.target)}" ` +
      `case_sensitive="${t.case_sensitive ? 'true' : 'false'}"${note}/>`
    )
  }
  lines.push('</glossary>')
  return lines.join('\n')
}

export const SEGMENT_TRANSLATE_SYSTEM =
  'You are a professional subtitle translator. Translate each <line> inside <lines> ' +
  'from {source_lang} to {target_lang}. Lines are consecutive subtitles of one video: ' +
  'use the surrounding lines for meaning, but translate every line on its own — never ' +
  'move words between lines, merge lines, split lines, or skip a line. Strictly obey ' +
  'terms in <glossary>. Each translation must be entirely in {target_lang}, except ' +
  'proper nouns, placeholders, or glossary terms that genuinely must remain; slang, ' +
  'interjections and sound effects are translated or naturally adapted too. Preserve ' +
  'numbers and placeholders exactly. <previous_lines> are context only; do not translate ' +
  'them. Return ONLY a JSON object described in <output_format>; no prose, no code fences.'

export function buildSegmentTranslatePrompt(sourceLang, targetLang, lines, glossary, previousLines) {
  const system = SEGMENT_TRANSLATE_SYSTEM
    .replace('{source_lang}', languageLabel(sourceLang))
    .replace('{target_lang}', languageLabel(targetLang))
  const parts = []
  const gb = glossaryBlock(glossary)
  if (gb) parts.push(gb)
  if (Array.isArray(previousLines) && previousLines.length) {
    parts.push(
      '<previous_lines>\n' +
      previousLines.map((t) => `<line>${xmlEscape(t)}</line>`).join('\n') +
      '\n</previous_lines>'
    )
  }
  parts.push(
    '<lines>\n' +
    (lines || []).map(([key, text]) => `<line id="${xmlEscape(String(key))}">${xmlEscape(text)}</line>`).join('\n') +
    '\n</lines>'
  )
  const ids = (lines || []).map(([key]) => `"${key}"`).join(', ')
  parts.push(
    '<output_format>{"translations": [{"id": "<line id>", "translation": "<text>"}]} ' +
    `with exactly one entry for each id: ${ids}.</output_format>`
  )
  return { system, prompt: parts.join('\n') }
}

// Deterministic post-check: glossary term present in source (case per flag)
// but its target missing from translation → soft warning (never hard-fail).
export function checkGlossaryCompliance(source, translation, glossary) {
  const warnings = []
  for (const t of Array.isArray(glossary) ? glossary : []) {
    if (!t?.source || !t?.target) continue
    const flags = t.case_sensitive ? '' : 'i'
    let inSource = false
    try {
      const esc = String(t.source).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      inSource = new RegExp(esc, flags).test(String(source || ''))
    } catch (_) {
      inSource = String(source || '').toLowerCase().includes(String(t.source).toLowerCase())
    }
    if (!inSource) continue
    const tgt = String(translation || '')
    const want = String(t.target)
    const inTarget = t.case_sensitive ? tgt.includes(want) : tgt.toLowerCase().includes(want.toLowerCase())
    if (!inTarget) warnings.push(`glossary term missed: ${t.source}→${t.target}`)
  }
  return warnings
}

export default { languageLabel, xmlEscape, glossaryBlock, buildSegmentTranslatePrompt, checkGlossaryCompliance, SEGMENT_TRANSLATE_SYSTEM }
