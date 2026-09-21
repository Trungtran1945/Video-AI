// Source discriminator: OCR rows là visible subtitles, ASR rows là speech
// transcript. selectModePool chọn pool theo mode, fallback legacy NULL.
// Chạy: node tests/transcriptSource.test.mjs
import { selectModePool } from '../src/pipeline/stages/dubMerge.js'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const ocr = (id) => ({ id, source: 'ocr', text: 'sub' })
const asr = (id) => ({ id, source: 'asr', text: 'speech' })
const legacy = (id) => ({ id, source: null, text: 'old' })

// 1. ocrMode + mixed → chỉ OCR rows (ASR hallucination không thành subtitle)
{
  const pool = selectModePool([ocr('o1'), asr('a1'), ocr('o2')], { ocrMode: true })
  assert(pool.map((s) => s.id).join(',') === 'o1,o2', 'ocrMode loại ASR rows')
}

// 2. ocrMode + legacy NULL (project cũ, OCR chạy trước migration) → giữ hết
{
  const pool = selectModePool([legacy('l1'), legacy('l2')], { ocrMode: true })
  assert(pool.length === 2, 'ocrMode legacy NULL fallback giữ hết')
}

// 3. STT mode + mixed → loại OCR rows
{
  const pool = selectModePool([ocr('o1'), asr('a1'), legacy('l1')], { ocrMode: false })
  assert(pool.map((s) => s.id).join(',') === 'a1,l1', 'stt mode loại OCR rows, giữ asr+legacy')
}

// 4. STT mode toàn legacy → giữ hết (hành vi cũ)
{
  const pool = selectModePool([legacy('l1')], {})
  assert(pool.length === 1, 'stt legacy giữ nguyên')
}

// 5. Rỗng → rỗng
{
  assert(selectModePool([], { ocrMode: true }).length === 0, 'rỗng -> rỗng')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
