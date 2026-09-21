// OCR subtitle detection hardening: filterOcrNoise loại UI text/logo/noise,
// aggregateBoxes giữ bbox+confidence, drop logo tĩnh + sai script.
// Chạy: node tests/subtitleDetect.test.mjs
import { filterOcrNoise, aggregateBoxes, normalizeText } from '../src/pipeline/stages/dubOcr.js'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const H = 720
const box = (o) => ({ x: 100, y: 600, width: 400, height: 40, confidence: 0.9, timestamp: 0, ...o })

// 1. Giữ subtitle đáy hợp lệ
{
  const kept = filterOcrNoise([box({ text: 'Hello world' })], { width: 1280, height: H })
  assert(kept.length === 1, 'giữ subtitle đáy hợp lệ')
}

// 2. Loại logo/UI top-screen nhỏ
{
  const kept = filterOcrNoise([box({ text: 'LIVE', x: 20, y: 10, width: 60, height: 18, confidence: 0.95 })], { width: 1280, height: H })
  assert(kept.length === 0, 'loại text nhỏ top-screen (logo/UI)')
}

// 3. Loại confidence thấp
{
  const kept = filterOcrNoise([box({ text: 'Hello world', confidence: 0.1 })], { width: 1280, height: H })
  assert(kept.length === 0, 'loại confidence thấp')
}

// 4. Loại noise ký hiệu
{
  const kept = filterOcrNoise([box({ text: '... !!!', confidence: 0.9 })], { width: 1280, height: H })
  assert(kept.length === 0, 'loại noise không đủ ký tự chữ')
}

// 5. aggregateBoxes giữ bbox + confidence + frameCount (evidence cho mask/render)
{
  const boxes = [
    box({ text: 'Hello world', timestamp: 0 }),
    box({ text: 'Hello world', timestamp: 0.5 }),
  ]
  const segs = aggregateBoxes(boxes, 10, 2, { frameStep: 0.5, height: H })
  assert(segs.length === 1, `gộp 2 frame thành 1 segment (got ${segs.length})`)
  assert(segs[0] && segs[0].bbox && Math.abs(segs[0].bbox.y - 600) < 1, 'giữ bbox trung bình')
  assert(segs[0] && Math.abs(segs[0].confidence - 0.9) < 1e-9, 'giữ confidence')
  assert(segs[0] && segs[0].text === 'Hello world', 'giữ nguyên text gốc, không paraphrase')
  assert(segs[0] && segs[0].source === 'ocr', 'đánh dấu source=ocr')
}

// 6. Drop logo/watermark tĩnh (cùng text phủ >60% video)
{
  const boxes = []
  for (let t = 0; t <= 9; t += 0.5) boxes.push(box({ text: 'TV CHANNEL', x: 20, y: 10, width: 120, height: 24, confidence: 0.95, timestamp: t }))
  const segs = aggregateBoxes(boxes, 10, 2, { frameStep: 0.5, height: H })
  assert(segs.length === 0, `drop watermark tĩnh phủ cả video (got ${segs.length})`)
}

// 7. Script gate: sourceLanguage=en + text CJK chiếm đa số → drop
{
  const boxes = [
    box({ text: '你好世界朋友们', timestamp: 0 }),
    box({ text: '你好世界朋友们', timestamp: 0.5 }),
  ]
  const segsEn = aggregateBoxes(boxes, 10, 2, { frameStep: 0.5, height: H, sourceLanguage: 'en' })
  assert(segsEn.length === 0, 'sourceLanguage=en loại segment CJK')
  const segsAuto = aggregateBoxes(boxes, 10, 2, { frameStep: 0.5, height: H, sourceLanguage: 'auto' })
  assert(segsAuto.length === 1, 'sourceLanguage=auto giữ nguyên (không đoán)')
}

// 8. Không merge hai subtitle khác nhau chỉ vì gần nhau
{
  const boxes = [
    box({ text: 'Good morning everyone', timestamp: 0 }),
    box({ text: 'Good morning everyone', timestamp: 0.5 }),
    box({ text: 'The weather is terrible today', timestamp: 3 }),
    box({ text: 'The weather is terrible today', timestamp: 3.5 }),
  ]
  const segs = aggregateBoxes(boxes, 10, 2, { frameStep: 0.5, height: H })
  assert(segs.length === 2, `2 subtitle khác nhau thành 2 segment (got ${segs.length})`)
}

// 9. Single-frame đơn lẻ không tạo segment (tin cậy đơn frame)
{
  const segs = aggregateBoxes([box({ text: 'Hello world', timestamp: 1, confidence: 0.4 })], 10, 2, { frameStep: 0.5, height: H })
  assert(segs.length === 0, 'frame đơn lẻ conf thấp không tạo segment')
}

assert(typeof normalizeText === 'function', 'giữ helper normalizeText hiện có')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
