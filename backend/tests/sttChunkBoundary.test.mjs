// Chunk-boundary stitching: overlap window + timing guards.
// Verifies dedupe across simulated chunk outputs with offsets.
// Run: node backend/tests/sttChunkBoundary.test.mjs

const { dedupeOverlapSegments, buildSttChunks } = await import('../src/pipeline/sttUtils.js')

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

// Chunk plan sanity (300s chunk + 15s overlap)
{
  const chunks = buildSttChunks(650, { chunkSec: 300, overlapSec: 15 })
  assert(chunks.length === 3, `650s → 3 chunks (got ${chunks.length})`)
  assert(chunks[1].start === 285, `overlap step 285 (got ${chunks[1].start})`)
}

// Simulated two chunks with 15s overlap producing suffix/prefix duplicates
{
  const raw = [
    { start: 283, end: 286, text: 'and then they walk into the room' },
    { start: 285.5, end: 288, text: 'they walk into the room together' },
    { start: 289, end: 292, text: 'An independent next sentence here' },
  ]
  const out = dedupeOverlapSegments(raw, { windowSec: 1.0 })
  assert(out.length === 2, `boundary merges overlap, keeps independent (got ${out.length})`)
  assert(out[0].text === 'and then they walk into the room together', `boundary merged text (got "${out[0].text}")`)
  assert(out[0].start === 283 && out[0].end === 288, 'boundary timestamps stitched')
}

// Out-of-order input sorted by start before stitching
{
  const out = dedupeOverlapSegments([
    { start: 5, end: 7, text: 'welcome to the show' },
    { start: 0, end: 3, text: 'Hello everyone welcome' },
    { start: 2.5, end: 5.5, text: 'everyone welcome to the show' },
  ])
  assert(out.length === 1, `unsorted inputs still stitch to 1 (got ${out.length})`)
}

// Negative small gap (overlap) still merges; large negative does not corrupt
{
  const out = dedupeOverlapSegments([
    { start: 0, end: 4, text: 'Hello everyone welcome' },
    { start: 3.5, end: 6, text: 'everyone welcome to the show' },
  ])
  assert(out.length === 1, 'small negative gap (overlap) merges')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
