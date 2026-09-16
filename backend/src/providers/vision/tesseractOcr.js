import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createWorker } from 'tesseract.js'

const execFileAsync = promisify(execFile)

// Thư mục chứa *.traineddata cục bộ (backend/eng.traineddata, chi_sim.traineddata, chi_tra.traineddata).
// tesseract.js v6 KHÔNG dùng TESSDATA_PREFIX (biến đó chỉ native tesseract binary dùng).
// Node worker đọc cache local trước: `${cachePath}/${lang}.traineddata`, miss → tải từ CDN jsdelivr.
const TESSDATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// Language mapping from project sourceLanguage to Tesseract traineddata codes
const LANG_MAP = {
  en: 'eng',
  ja: 'jpn',
  ko: 'kor',
  zh: 'chi_sim',
  'zh-TW': 'chi_tra',
  vi: 'vie',
  fr: 'fra',
  de: 'deu',
  es: 'spa',
}

export function mapLanguage(sourceLanguage) {
  // auto dùng detection/fallback eng — KHÔNG silent zh->eng: chỉ map đúng code user chọn.
  if (!sourceLanguage || sourceLanguage === 'auto') return ['eng']
  const code = sourceLanguage.trim()
  if (code.includes('+')) {
    return code.split('+').map(c => LANG_MAP[c] || c).filter(Boolean)
  }
  const mapped = LANG_MAP[code]
  return mapped ? [mapped] : [code]
}

// Vùng quét: chỉ giữ chữ nằm dưới tỷ lệ này của khung (phụ đề thường ở đáy).
const BOTTOM_RATIO = Number(process.env.OCR_BOTTOM_RATIO || 0.6)
// Page segmentation mode: 6 = khối văn bản đồng nhất (phù hợp 1-2 dòng phụ đề).
const PSM = Number.isFinite(Number(process.env.OCR_PSM)) ? Number(process.env.OCR_PSM) : 6
// Số worker song song (pool) — giới hạn bởi CPU để tránh quá tải.
const POOL = Math.max(1, Number(process.env.OCR_CONCURRENCY) || Math.min(os.cpus().length || 1, 4))

// Worker pool riêng theo ngôn ngữ: đổi lang không terminate pool khác.
const pools = new Map()

function createPool(langStr) {
  return (async () => {
    const ws = []
    try {
      // cachePath=TESSDATA_DIR: ưu tiên *.traineddata local (backend/), miss → CDN jsdelivr.
      for (let i = 0; i < POOL; i++) ws.push(await createWorker(langStr, undefined, { cachePath: TESSDATA_DIR }))
    } catch (err) {
      pools.delete(langStr)
      const msg = `Missing traineddata "${langStr}" (sourceLanguage map → "${langStr}"). `
        + `Tải ${langStr}.traineddata vào ${TESSDATA_DIR} hoặc backend/. `
        + `Xem https://github.com/tesseract-ocr/tessdata_best. `
        + `Original error: ${err.message}`
      throw new Error(msg)
    }
    return ws
  })()
}

function poolFor(langStr) {
  let p = pools.get(langStr)
  if (!p) {
    p = { promise: createPool(langStr), rr: 0 }
    pools.set(langStr, p)
  }
  return p
}

export async function getWorkers(langKey) {
  const langStr = Array.isArray(langKey) ? langKey.join('+') : (langKey || 'eng')
  return poolFor(langStr).promise
}

export async function closePools() {
  const entries = [...pools.values()]
  pools.clear()
  for (const p of entries) {
    try {
      const ws = await p.promise
      await Promise.all((ws || []).map((w) => {
        try { return w.terminate() } catch { return null }
      }))
    } catch {}
  }
}

export async function _clearPoolsForTest() {
  await closePools()
}

process.on('exit', () => {
  try {
    for (const p of pools.values()) {
      p.promise.then((ws) => {
        for (const w of ws || []) {
          try {
            const r = w.terminate()
            if (r && typeof r.catch === 'function') r.catch(() => {})
          } catch {}
        }
      }).catch(() => {})
    }
  } catch {}
})

async function cropSubtitleROI(imagePath, width, height, bottomRatio = 0.4) {
  const cropHeight = Math.round(height * bottomRatio)
  const cropY = height - cropHeight
  const outPath = imagePath.replace(/\.jpg$/i, '_crop.jpg')
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', imagePath,
      '-vf', `crop=${width}:${cropHeight}:0:${cropY}`,
      '-q:v', '3',
      outPath,
    ])
    return { croppedPath: outPath, cropY, cropHeight }
  } catch {
    return { croppedPath: imagePath, cropY: 0, cropHeight: height }
  }
}

async function preprocessImage(imagePath) {
  const outPath = imagePath.replace(/\.jpg$/i, '_pre.jpg')
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', imagePath,
      '-vf', 'eq=contrast=1.3:brightness=0.05,format=gray',
      '-q:v', '3',
      outPath,
    ])
    return outPath
  } catch {
    return imagePath
  }
}

export function filterSubtitleBoxes(boxes, { width = 1280, height = 720 } = {}) {
  const h = Number(height) || 720
  const minConf = Number(process.env.OCR_MIN_BOX_CONF || 0.35)
  const minH = h * Number(process.env.OCR_MIN_HEIGHT_RATIO || 0.012)
  const bottomTop = h * (1 - Number(process.env.OCR_BOTTOM_RATIO || 0.6))
  return (boxes || []).filter((b) => {
    const text = String(b?.text || '').trim()
    if (text.length < 2) return false
    if ((Number(b.confidence) || 0) < minConf) return false
    if ((Number(b.height) || 0) < minH) return false
    // Subtitle-position consistency: keep bottom band only (reject logo/watermark/top scene text)
    const y = Number(b.y) || 0
    if (y < bottomTop) return false
    // Reject mostly-symbol noise
    const letters = text.replace(/[^A-Za-zÀ-ỹ一-鿿぀-ヿ가-힯]/g, '')
    if (letters.length < 2) return false
    return true
  })
}

export class TesseractOcr {
  constructor() {
    this.id = 'tesseract'
    this.model = 'tesseract'
  }

  async detectSubtitle({ imagePath, width, height, sourceLanguage }) {
    const w = Number(width) || 1280
    const h = Number(height) || 720

    const langCodes = mapLanguage(sourceLanguage)
    const langStr = langCodes.join('+')
    const workers = await getWorkers(langCodes)
    const worker = workers[poolFor(langStr).rr++ % workers.length]

    let croppedPath = imagePath
    let preprocessedPath = imagePath
    let cropY = 0
    try {
      const roi = await cropSubtitleROI(imagePath, w, h, BOTTOM_RATIO)
      croppedPath = roi.croppedPath
      cropY = roi.cropY

      preprocessedPath = await preprocessImage(croppedPath)

      const { data } = await worker.recognize(
        preprocessedPath,
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

          const confidence = words.length ? confSum / words.length / 100 : 0.6
          boxes.push({
            x: Math.round(minX),
            y: Math.round(minY + cropY),
            width: Math.round(Math.max(1, maxX - minX)),
            height: Math.round(Math.max(1, maxY - minY)),
            text: text.trim(),
            confidence: Number.isFinite(confidence) ? confidence : 0.6,
          })
        }
      }

      return { boxes: filterSubtitleBoxes(boxes, { width: w, height: h }), model: this.model, usage: null }
    } finally {
      if (croppedPath !== imagePath) {
        fs.promises.unlink(croppedPath).catch(() => {})
      }
      if (preprocessedPath !== imagePath && preprocessedPath !== croppedPath) {
        fs.promises.unlink(preprocessedPath).catch(() => {})
      }
    }
  }
}

export default TesseractOcr
