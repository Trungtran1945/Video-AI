// TDD RED: Tesseract ROI/bbox filtering keeps contract
// Run: node backend/tests/tesseractFilter.test.mjs
import { filterSubtitleBoxes } from '../src/providers/vision/tesseractOcr.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const out = filterSubtitleBoxes([
  { x: 10, y: 10, width: 100, height: 12, text: 'LOGO TV', confidence: 0.95 },
  { x: 100, y: 650, width: 400, height: 30, text: 'Xin chào', confidence: 0.8 },
  { x: 120, y: 655, width: 50, height: 4, text: 'dot', confidence: 0.9 },
  { x: 110, y: 652, width: 300, height: 28, text: '???', confidence: 0.1 },
], { width: 1280, height: 720 })

assert(out.length === 1 && out[0].text === 'Xin chào', `watermark/small/low-conf rejected (got ${JSON.stringify(out.map(o => o.text))})`)
assert(out[0] && typeof out[0].x === 'number' && typeof out[0].confidence === 'number', 'contract {x,y,width,height,text,confidence} preserved')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
