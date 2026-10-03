// TransFlow XML prompt regression: one-to-one ids, context-only previous
// lines, glossary block, language labels, compliance check. Pure — no DB.
// Run: node tests/translatePrompt.test.mjs
const {
  languageLabel,
  xmlEscape,
  glossaryBlock,
  buildSegmentTranslatePrompt,
  checkGlossaryCompliance,
} = await import('../src/pipeline/translatePrompt.js')

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// 1. Language labels carry native name + wire code
assert(languageLabel('vi').includes('tiếng Việt') && languageLabel('vi').includes('vi'), 'vi label')
assert(languageLabel('ja').includes('日本語'), 'ja native name')
assert(languageLabel('zh-CN').includes('zh-CN'), 'zh-CN code preserved')

// 2. XML escaping
assert(xmlEscape('a<b>&"c"') === 'a&lt;b&gt;&amp;"c"', 'xml escape')

// 3. Glossary block structure
{
  const gb = glossaryBlock([
    { source: 'Sensei', target: 'Thầy', case_sensitive: true, note: 'respect' },
    { source: '', target: 'x' },
  ])
  assert(gb.includes('<glossary>') && gb.includes('</glossary>'), 'glossary wrapper')
  assert(gb.includes('source="Sensei"') && gb.includes('target="Thầy"'), 'term attrs')
  assert(gb.includes('case_sensitive="true"'), 'case flag')
  assert(gb.includes('note="respect"'), 'note attr')
  assert(glossaryBlock([]) === '', 'empty glossary -> empty block')
  assert(glossaryBlock(null) === '', 'null glossary -> empty block')
}

// 4. Segment prompt: exact ids, one-to-one, context-only
{
  const { system, prompt } = buildSegmentTranslatePrompt('en', 'vi',
    [['1', 'Hey!'], ['2', "What's up?"]],
    [{ source: 'Hey', target: 'Này', case_sensitive: false, note: null }],
    ['Previously he said hi.'])
  assert(system.includes('never') && system.includes('skip a line'), 'system one-to-one rule')
  assert(prompt.includes('<glossary>'), 'prompt has glossary')
  assert(prompt.includes('<previous_lines>'), 'prompt has previous_lines')
  assert(prompt.includes('<line id="1">Hey!</line>'), 'line 1 tagged')
  assert(prompt.includes('<line id="2">'), 'line 2 tagged')
  assert(prompt.includes('"1", "2"'), 'output_format exact ids')
  assert(prompt.includes('do not translate') || system.includes('context only'), 'context-only marker')
}

// 5. No glossary / no context → blocks omitted, lines intact
{
  const { prompt } = buildSegmentTranslatePrompt('ja', 'vi', [['1', 'こんにちは']], [], [])
  assert(!prompt.includes('<glossary>'), 'no glossary block when empty')
  assert(!prompt.includes('<previous_lines>'), 'no previous_lines when empty')
  assert(prompt.includes('<line id="1">'), 'line still present')
}

// 6. Compliance: missed term warns, applied term passes
{
  const g = [{ source: 'Bankai', target: 'Vạn Giải', case_sensitive: false }]
  assert(checkGlossaryCompliance('Use Bankai now', 'Hãy dùng Vạn Giải ngay', g).length === 0, 'applied term ok')
  assert(checkGlossaryCompliance('Use Bankai now', 'Hãy dùng nó ngay', g).length === 1, 'missed term warns')
  const cs = [{ source: 'bankai', target: 'Vạn Giải', case_sensitive: true }]
  assert(checkGlossaryCompliance('Use Bankai now', 'Hãy dùng nó ngay', cs).length === 0, 'case-sensitive respects case')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
