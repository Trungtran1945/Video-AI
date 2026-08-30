// Test nhanh provider Tesseract OCR trên 1 ảnh frame.
// Cách chạy: node scripts/testTesseractOcr.mjs <đường_dẫn_ảnh> [width] [height]
// Lần đầu chạy cần mạng để tải tessdata (eng).
import TesseractOcr from '../src/providers/vision/tesseractOcr.js'

const imagePath = process.argv[2]
if (!imagePath) {
  console.error('Thiếu đường dẫn ảnh. Ví dụ: node scripts/testTesseractOcr.mjs frame.jpg 1280 720')
  process.exit(1)
}
const width = Number(process.argv[3]) || 1280
const height = Number(process.argv[4]) || 720

const ocr = new TesseractOcr()
console.time('detectSubtitle')
const { boxes, model } = await ocr.detectSubtitle({ imagePath, width, height })
console.timeEnd('detectSubtitle')
console.log('model:', model)
console.log('số box:', boxes.length)
console.log(JSON.stringify(boxes, null, 2))
// Worker Tesseract giữ event loop sống → thoát tường minh cho script test.
process.exit(0)
