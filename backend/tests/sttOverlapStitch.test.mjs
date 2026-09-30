// Overlap stitching: longest normalized suffix/prefix merge.
// Example: A "Hello everyone welcome" + B "everyone welcome to the show"
// → "Hello everyone welcome to the show". Independent sentences never merged.
// Run: node backend/tests/sttOverlapStitch.test.mjs

const { dedupeOverlapSegments } = await import('../src/pipeline/sttUtils.js')

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

// 1. Spec example
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 3, text: 'Hello everyone welcome' },
    { start: 2.5, end: 5, text: 'everyone welcome to the show' },
  ], { windowSec: 1.0 })
  assert(out.length === 1, `example merges to 1 (got ${out.length})`)
  assert(out[0].text === 'Hello everyone welcome to the show', `merged text correct (got "${out[0].text}")`)
  assert(out[0].start === 0 && out[0].end === 5, 'timestamps preserved (start=min, end=max)')
}

// 2. Exact duplicate still deduped
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 2, text: 'Hello world' },
    { start: 2.2, end: 4, text: 'Hello world' },
  ])
  assert(out.length === 1, 'exact duplicate dropped')
}

// 3. Independent sentences never merged (low similarity)
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 2, text: 'The cat sits on the mat' },
    { start: 2.2, end: 4, text: 'Quantum physics is fascinating' },
  ])
  assert(out.length === 2, 'independent sentences kept separate')
}

// 4. Timing gap invalid → no merge even with overlap words
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 2, text: 'Hello everyone welcome' },
    { start: 10, end: 12, text: 'everyone welcome to the show' },
  ], { windowSec: 1.0 })
  assert(out.length === 2, 'large timing gap prevents merge')
}

// 5. Case/whitespace/punctuation normalized but original preserved
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 3, text: '  Hello, EVERYONE welcome!  ' },
    { start: 2.8, end: 5, text: 'everyone welcome to THE show.' },
  ])
  assert(out.length === 1, 'normalized overlap merges')
  assert(out[0].text.toLowerCase().includes('hello'), 'original casing preserved in merged output')
}

// 6. Single common stopword ("the") does not trigger merge
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 2, text: 'I love the mountains' },
    { start: 2.1, end: 4, text: 'The ocean is vast and deep' },
  ])
  assert(out.length === 2, 'single stopword overlap does not merge')
}

// 7. Suffix containment: curr equals trailing overlap of prev → drop curr
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 5, text: 'Hello everyone welcome to the show' },
    { start: 4.5, end: 5.5, text: 'welcome to the show' },
  ])
  assert(out.length === 1, 'suffix-contained segment dropped')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
