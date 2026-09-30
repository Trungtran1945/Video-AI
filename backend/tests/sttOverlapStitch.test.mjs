// Overlap stitching: longest normalized suffix/prefix merge with 15s chunk overlap.
// Chunking uses STT_CHUNK_SEC=300 + STT_OVERLAP_SEC=15, so adjacent chunks share
// up to 15s of audio. Stitching must handle 0.5s → ~14s negative gaps.
// Example: A "Hello everyone welcome" + B "everyone welcome to the show"
// → "Hello everyone welcome to the show". Independent sentences never merged.
// Run: node backend/tests/sttOverlapStitch.test.mjs

const { dedupeOverlapSegments, STT_OVERLAP_SEC } = await import('../src/pipeline/sttUtils.js')

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

assert(STT_OVERLAP_SEC === 15, `STT_OVERLAP_SEC is 15 (got ${STT_OVERLAP_SEC})`)

// 1. Spec example (small overlap 0.5s)
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 3, text: 'Hello everyone welcome' },
    { start: 2.5, end: 5, text: 'everyone welcome to the show' },
  ], { windowSec: 1.0 })
  assert(out.length === 1, `example merges to 1 (got ${out.length})`)
  assert(out[0].text === 'Hello everyone welcome to the show', `merged text correct (got "${out[0].text}")`)
  assert(out[0].start === 0 && out[0].end === 5, 'timestamps preserved (start=min, end=max)')
}

// 1b. Overlap ~0.5s with 20s segments
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 20, text: 'Hello everyone welcome' },
    { start: 19.5, end: 25, text: 'everyone welcome to the show' },
  ], { windowSec: 1.0 })
  assert(out.length === 1, `0.5s overlap merges (got ${out.length})`)
  assert(out[0].text === 'Hello everyone welcome to the show', `0.5s merged text (got "${out[0].text}")`)
}

// 2. Overlap ~2s
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 20, text: 'Hello everyone welcome' },
    { start: 18, end: 25, text: 'everyone welcome to the show' },
  ], { windowSec: 1.0 })
  assert(out.length === 1, `2s overlap merges (got ${out.length})`)
  assert(out[0].text === 'Hello everyone welcome to the show', `2s merged text (got "${out[0].text}")`)
}

// 3. Overlap ~5s (core regression: old -2.0 gate dropped this)
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 20, text: 'Hello everyone welcome' },
    { start: 15, end: 25, text: 'everyone welcome to the show' },
  ], { windowSec: 1.0 })
  assert(out.length === 1, `5s overlap merges (got ${out.length})`)
  assert(out[0].text === 'Hello everyone welcome to the show', `5s merged text (got "${out[0].text}")`)
  assert(out[0].start === 0 && out[0].end === 25, '5s timestamps start=min end=max')
}

// 4. Overlap ~10s
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 20, text: 'and then they walk into the room' },
    { start: 10, end: 25, text: 'they walk into the room together now' },
  ], { windowSec: 1.0 })
  assert(out.length === 1, `10s overlap merges (got ${out.length})`)
  assert(out[0].text === 'and then they walk into the room together now', `10s merged text (got "${out[0].text}")`)
}

// 5. Overlap ~14s (near 15s limit)
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 20, text: 'Hello everyone welcome' },
    { start: 6, end: 25, text: 'everyone welcome to the show tonight' },
  ], { windowSec: 1.0 })
  assert(out.length === 1, `14s overlap merges (got ${out.length})`)
  assert(out[0].text === 'Hello everyone welcome to the show tonight', `14s merged text (got "${out[0].text}")`)
}

// 5b. Beyond 15s overlap must NOT merge (architecture bound)
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 20, text: 'Hello everyone welcome' },
    { start: 4, end: 25, text: 'everyone welcome to the show' },
  ], { windowSec: 1.0, overlapSec: 15 })
  // gap = 4-20 = -16 → outside [-15, 1.0) → kept separate
  assert(out.length === 2, `16s overlap (beyond 15s) stays separate (got ${out.length})`)
}

// 6. Partial suffix/prefix with speaker/language preserved
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 20, text: 'Hello everyone welcome', speaker: 'spk1', language: 'en' },
    { start: 15, end: 25, text: 'everyone welcome to the show', speaker: 'spk1', language: 'en' },
  ], { windowSec: 1.0 })
  assert(out.length === 1, 'partial suffix/prefix merges')
  assert(out[0].speaker === 'spk1' && out[0].language === 'en', 'speaker/language preserved')
}

// 6b. Speaker inherit when prev lacks it
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 20, text: 'Hello everyone welcome' },
    { start: 15, end: 25, text: 'everyone welcome to the show', speaker: 'spk2', language: 'vi' },
  ], { windowSec: 1.0 })
  assert(out.length === 1 && out[0].speaker === 'spk2' && out[0].language === 'vi', 'inherits speaker/language from curr when prev null')
}

// 7. Full containment: curr entirely inside prev overlap → drop curr
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 5, text: 'Hello everyone welcome to the show' },
    { start: 4.5, end: 5.5, text: 'welcome to the show' },
  ])
  assert(out.length === 1, 'suffix-contained segment dropped')
}

// 7b. Exact duplicate still deduped
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 2, text: 'Hello world' },
    { start: 2.2, end: 4, text: 'Hello world' },
  ])
  assert(out.length === 1, 'exact duplicate dropped')
}

// 8. Unrelated sentences in same timing window → never merged
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 20, text: 'The cat sits on the mat' },
    { start: 15, end: 25, text: 'Quantum physics is fascinating today' },
  ], { windowSec: 1.0 })
  assert(out.length === 2, `unrelated sentences with 5s timing overlap stay separate (got ${out.length})`)
}

// 8b. Independent sentences, small window
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 2, text: 'The cat sits on the mat' },
    { start: 2.2, end: 4, text: 'Quantum physics is fascinating' },
  ])
  assert(out.length === 2, 'independent sentences kept separate')
}

// 9. Single common stopword ("the") does not trigger merge
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 2, text: 'I love the mountains' },
    { start: 2.1, end: 4, text: 'The ocean is vast and deep' },
  ])
  assert(out.length === 2, 'single stopword overlap does not merge')
}

// 9b. Single stopword with large timing overlap also does not merge
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 20, text: 'I love the mountains here' },
    { start: 15, end: 25, text: 'The ocean is vast and deep blue' },
  ], { windowSec: 1.0 })
  assert(out.length === 2, 'single stopword with 5s overlap does not merge')
}

// 10. CJK / no-space language char-level overlap
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 20, text: '大家欢迎来到现场节目' },
    { start: 15, end: 25, text: '欢迎来到现场节目表演' },
  ], { windowSec: 1.0 })
  assert(out.length === 1, `CJK char overlap merges (got ${out.length})`)
  assert(out[0].text === '大家欢迎来到现场节目表演', `CJK merged text (got "${out[0]?.text}")`)
  assert(out[0].start === 0 && out[0].end === 25, 'CJK timestamps preserved')
}

// 10b. CJK unrelated stays separate
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 20, text: '今天天气非常好' },
    { start: 15, end: 25, text: '量子物理很有趣' },
  ], { windowSec: 1.0 })
  assert(out.length === 2, 'CJK unrelated stays separate')
}

// 11. Case/whitespace/punctuation normalized but original preserved
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 3, text: '  Hello, EVERYONE welcome!  ' },
    { start: 2.8, end: 5, text: 'everyone welcome to THE show.' },
  ])
  assert(out.length === 1, 'normalized overlap merges')
  assert(out[0].text.toLowerCase().includes('hello'), 'original casing preserved in merged output')
}

// 12. Timing gap invalid → no merge even with overlap words
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 2, text: 'Hello everyone welcome' },
    { start: 10, end: 12, text: 'everyone welcome to the show' },
  ], { windowSec: 1.0 })
  assert(out.length === 2, 'large timing gap prevents merge')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
