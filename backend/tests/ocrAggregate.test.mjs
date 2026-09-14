// TDD RED: OCR fuzzy temporal aggregation
// Run: node backend/tests/ocrAggregate.test.mjs
import { aggregateBoxes, textSim, normalizeText } from '../src/pipeline/stages/dubOcr.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

assert(textSim('Hello world', 'hello  world!') >= 0.82, 'fuzzy text similarity groups OCR noise')
assert(normalizeText('  Hello   WORLD ') === 'hello world', 'normalizeText lowercases/collapses')

const boxes = [
  { text: 'Hello world', confidence: 0.9, timestamp: 1.0, y: 600, height: 40, x: 100, width: 400 },
  { text: 'hello  world!', confidence: 0.85, timestamp: 1.5, y: 602, height: 40, x: 102, width: 398 },
  { text: 'hello world', confidence: 0.88, timestamp: 2.0, y: 601, height: 40, x: 101, width: 399 },
]
const segs = aggregateBoxes(boxes, 100, 2)
assert(segs.length === 1, `temporal aggregation groups 3 frames into 1 (got ${segs.length})`)
assert(/hello/i.test(segs[0]?.text || ''), 'majority text preserved')
assert(segs[0].start_sec <= 1.01 && segs[0].end_sec <= 3.0 && segs[0].end_sec > segs[0].start_sec, `timing uses fps step, not +1 blind (${segs[0]?.start_sec}-${segs[0]?.end_sec})`)

// Isolated singleton rejected
const single = aggregateBoxes([{ text: 'Noise?', confidence: 0.4, timestamp: 10, y: 600, height: 40, x: 100, width: 200 }], 100, 2)
assert(single.length === 0, 'isolated low-quality singleton rejected')

// Bounds clamp
const clamp = aggregateBoxes([
  { text: 'Same line here', confidence: 0.9, timestamp: 98, y: 600, height: 40, x: 100, width: 400 },
  { text: 'Same line here', confidence: 0.9, timestamp: 99, y: 600, height: 40, x: 100, width: 400 },
], 100, 2)
assert(clamp[0].end_sec <= 100 && clamp[0].start_sec >= 0, 'timestamps clamped inside video duration')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
