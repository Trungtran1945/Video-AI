// TransFlow batch technique regression: splitLlmBatches caps, multi-shape
// parser, normalizeSourceText. Pure helpers — no provider/DB needed.
// Run: node tests/dubTranslate.batch.test.mjs
import path from 'node:path'
import os from 'node:os'

// Set env BEFORE import (module load-time resolves paths).
process.env.DB_PATH = path.join(os.tmpdir(), `vidai_test_batch_${Date.now()}.db`)

const {
  splitLlmBatches,
  parseLlmBatchPayload,
  normalizeSourceText,
  LLM_BATCH_MAX_LINES,
  LLM_BATCH_MAX_CHARS,
  LLM_BATCH_CONCURRENCY,
  LLM_CONTEXT_LINES,
} = await import('../src/pipeline/stages/dubTranslate.js')

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const seg = (i, text = `câu ${i}`, start = i * 2, end = i * 2 + 1.5) => ({
  index_num: i, text, start_sec: start, end_sec: end,
})

// 1. Constants match TransFlow technique
assert(LLM_BATCH_MAX_LINES === 30, `MAX_LINES=30 (got ${LLM_BATCH_MAX_LINES})`)
assert(LLM_BATCH_MAX_CHARS === 2500, `MAX_CHARS=2500 (got ${LLM_BATCH_MAX_CHARS})`)
assert(LLM_BATCH_CONCURRENCY === 2, `CONCURRENCY=2 (got ${LLM_BATCH_CONCURRENCY})`)
assert(LLM_CONTEXT_LINES === 3, `CONTEXT_LINES=3 (got ${LLM_CONTEXT_LINES})`)

// 2. Line cap: 35 short segs in one window -> 30 + 5
{
  const segs = Array.from({ length: 35 }, (_, i) => seg(i))
  const groups = splitLlmBatches(segs, 3600)
  assert(groups.length === 2, `35 segs -> 2 groups (got ${groups.length})`)
  assert(groups[0].length === 30 && groups[1].length === 5,
    `sizes 30+5 (got ${groups.map((g) => g.length).join('+')})`)
  const order = groups.flat().map((s) => s.index_num)
  assert(order.every((v, i) => v === i), 'order preserved, no loss/dup')
}

// 3. Char cap: 2 segs x 2000 chars -> split
{
  const segs = [seg(0, 'a'.repeat(2000)), seg(1, 'b'.repeat(2000))]
  const groups = splitLlmBatches(segs, 3600)
  assert(groups.length === 2, `4000 chars -> 2 groups (got ${groups.length})`)
}

// 4. Window still splits (45s default honors timing)
{
  const segs = [seg(0, 'hello', 0, 1), seg(1, 'world', 100, 101)]
  const groups = splitLlmBatches(segs, 45)
  assert(groups.length === 2, `far-apart timing -> 2 groups (got ${groups.length})`)
}

// 5. Small input stays one batch
{
  const segs = [seg(0), seg(1), seg(2)]
  const groups = splitLlmBatches(segs, 45)
  assert(groups.length === 1 && groups[0].length === 3, '3 segs -> 1 group')
}

// 6. Parser: {segments:[...]} (legacy shape)
{
  const m = parseLlmBatchPayload(JSON.stringify({ segments: [{ index: 7, translation: 'xin chào' }] }))
  assert(m.get(7) === 'xin chào', 'segments shape parsed')
}

// 7. Parser: {translations:[...]} (TransFlow shape)
{
  const m = parseLlmBatchPayload(JSON.stringify({ translations: [{ id: 3, translation: 'tạm biệt' }] }))
  assert(m.get(3) === 'tạm biệt', 'translations shape parsed')
}

// 8. Parser: {"id":text} dict shape
{
  const m = parseLlmBatchPayload(JSON.stringify({ 1: 'một', 2: 'hai' }))
  assert(m.get(1) === 'một' && m.get(2) === 'hai', 'dict shape parsed')
}

// 9. Parser: string index + blank rejection
{
  const m = parseLlmBatchPayload(JSON.stringify({ segments: [
    { index: '4', translation: 'bốn' },
    { index: 5, translation: '   ' },
    { index: 6, translation: '' },
  ] }))
  assert(m.get(4) === 'bốn', 'string index coerced')
  assert(!m.has(5) && !m.has(6), 'blanks rejected')
}

// 10. Parser: garbage -> empty map (no throw)
{
  const m = parseLlmBatchPayload('not json at all {{{')
  assert(m instanceof Map && m.size === 0, 'garbage -> empty map')
}

// 11. normalizeSourceText: collapse + trim
{
  assert(normalizeSourceText('  chào   bạn\nmới  ') === 'chào bạn mới', 'whitespace collapsed')
  assert(normalizeSourceText(null) === '', 'null -> empty')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
