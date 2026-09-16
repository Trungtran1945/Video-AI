// Track-based OCR aggregation: dual-line split + noise rejection
// Run: node backend/tests/ocrTracks.test.mjs
import { aggregateBoxes } from '../src/pipeline/stages/dubOcr.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// Test 7: two lines same timestamps, different y -> 2 separate segments
const boxes7 = [
  { text: 'HELLO WORLD TODAY', confidence: 0.9, timestamp: 1.0, y: 600, height: 40, x: 100, width: 400 },
  { text: 'GOODBYE MOON NIGHT', confidence: 0.92, timestamp: 1.0, y: 660, height: 40, x: 100, width: 400 },
  { text: 'Hello world today', confidence: 0.88, timestamp: 1.5, y: 602, height: 40, x: 102, width: 398 },
  { text: 'Goodbye moon night!', confidence: 0.9, timestamp: 1.5, y: 662, height: 40, x: 101, width: 399 },
  { text: 'hello WORLD today', confidence: 0.91, timestamp: 2.0, y: 601, height: 40, x: 101, width: 399 },
  { text: 'goodbye MOON night', confidence: 0.89, timestamp: 2.0, y: 661, height: 40, x: 100, width: 400 },
]
const segs7 = aggregateBoxes(boxes7, 100, 2)
assert(segs7.length === 2, `dual-line split into 2 segments (got ${segs7.length}: ${JSON.stringify(segs7.map(s => s.text))})`)
const hasA = segs7.some((s) => /hello/i.test(s.text))
const hasB = segs7.some((s) => /goodbye/i.test(s.text))
assert(hasA && hasB, 'both line A and line B preserved separately')
assert(!segs7.some((s) => /hello/i.test(s.text) && /goodbye/i.test(s.text)), 'A and B not merged into one segment')

// Test 8: A A A NOISE A A -> NOISE rejected, single A segment
const boxes8 = [
  { text: 'Hello world', confidence: 0.9, timestamp: 1.0, y: 600, height: 40, x: 100, width: 400 },
  { text: 'hello world', confidence: 0.88, timestamp: 1.5, y: 601, height: 40, x: 101, width: 399 },
  { text: 'Hello world!', confidence: 0.9, timestamp: 2.0, y: 600, height: 40, x: 100, width: 400 },
  { text: 'XYZQW KLPVZ', confidence: 0.4, timestamp: 2.5, y: 602, height: 40, x: 100, width: 400 },
  { text: 'hello world', confidence: 0.89, timestamp: 3.0, y: 601, height: 40, x: 102, width: 398 },
  { text: 'Hello world', confidence: 0.91, timestamp: 3.5, y: 600, height: 40, x: 100, width: 400 },
]
const segs8 = aggregateBoxes(boxes8, 100, 2)
assert(segs8.length === 1, `interleaved noise rejected, single A segment (got ${segs8.length}: ${JSON.stringify(segs8.map(s => s.text))})`)
assert(/hello/i.test(segs8[0]?.text || ''), 'A text preserved')
assert(!/xyzqw|klpvz/i.test(segs8[0]?.text || ''), 'noise text not in segment')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
