import os from 'node:os'
import { createWorker } from 'tesseract.js'

// Provider OCR cục bộ (docs/05 §B.3) dùng Tesseract.js — chạy trên máy,
// KHÔNG gọi API, không bị giới hạn quota. Trả cùng định dạng {boxes,model,usage}
// như GeminiVision để stage dubOcr không cần đổi code.

// Ngôn ngữ phụ đề nguồn (tesseract hỗ trợ 'eng', 'vie', 'eng+vie', ...).
const LANG = (process.env.OCR_LANG || 'eng').split('+').filter(Boolean)
// Vùng quét: chỉ giữ chữ nằm dưới tỷ lệ này của khung (phụ đề thường ở đáy).
const BOTTOM_RATIO = Number(process.env.OCR_BOTTOM_RATIO || 0.6)
// Page segmentation mode: 6 = khối văn bản đồng nhất (phù hợp 1-2 dòng phụ đề).
const PSM = Number.isFinite(Number(process.env.OCR_PSM)) ? Number(process.env.OCR_PSM) : 6
// Số worker song song (pool) — giới hạn bởi CPU để tránh quá tải.
const POOL = Math.max(1, Number(process.env.OCR_CONCURRENCY) || Math.min(os.cpus().length || 1, 4))

let workersPromise = null
let rr = 0

// Tạo pool POOL worker Tesseract chia sẻ, khởi tạo 1 lần duy nhất.
// (Không dùng createScheduler vì API addJob ở v6 hay treo; tự phân phối round-robin.)
async function getWorkers() {
  if (!workersPromise) {
    workersPromise = (async () => {
      const ws = []
      // createWorker chấp nhận chuỗi ('eng') hoặc mảng; chuỗi an toàn hơn trên v6.
      const langArg = LANG.length === 1 ? LANG[0] : LANG
      for (let i = 0; i < POOL; i++) ws.push(await createWorker(langArg))
      return ws
    })()
  }
  return workersPromise
}

export class TesseractOcr {
  constructor() {
    this.id = 'tesseract'
    this.model = 'tesseract'
  }

  // Phát hiện phụ đề cứng: OCR toàn bộ frame, lọc chỉ vùng dưới khung.
  // Trả về [{x, y, width, height, text, confidence}] theo pixel khung hình.
  async detectSubtitle({ imagePath, width, height }) {
    const w = Number(width) || 1280
    const h = Number(height) || 720
    const top = Math.floor(h * BOTTOM_RATIO)

    const workers = await getWorkers()
    const worker = workers[rr++ % workers.length]
    const { data } = await worker.recognize(
      imagePath,
      { tessedit_pageseg_mode: PSM },
      { blocks: true }
    )

    const boxes = []
    const blocks = Array.isArray(data.blocks) ? data.blocks : []
    for (const block of blocks) {
      const lines = block.lines || []
      for (const line of lines) {
        const words = line.words || []
        if (!words.length) continue

        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        let text = ''
        let confSum = 0
        for (const word of words) {
          const b = word.bbox || {}
          const x0 = Number(b.x0)
          const y0 = Number(b.y0)
          const x1 = Number(b.x1)
          const y1 = Number(b.y1)
          if (!Number.isFinite(x0) || !Number.isFinite(x1)) continue
          minX = Math.min(minX, x0)
          minY = Math.min(minY, y0)
          maxX = Math.max(maxX, x1)
          maxY = Math.max(maxY, y1)
          text += (text ? ' ' : '') + (word.text || '')
          confSum += Number(word.confidence) || 0
        }
        if (!Number.isFinite(minX)) continue

        // Chỉ giữ dòng có tâm nằm trong vùng phụ đề (dưới BOTTOM_RATIO).
        const cy = (minY + maxY) / 2
        if (cy < top) continue

        const confidence = words.length ? confSum / words.length / 100 : 0.6
        boxes.push({
          x: Math.round(minX),
          y: Math.round(minY),
          width: Math.round(Math.max(1, maxX - minX)),
          height: Math.round(Math.max(1, maxY - minY)),
          text: text.trim(),
          confidence: Number.isFinite(confidence) ? confidence : 0.6,
        })
      }
    }

    return { boxes, model: this.model, usage: null }
  }
}

export default TesseractOcr
