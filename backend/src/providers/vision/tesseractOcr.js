import os from 'node:os'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createWorker } from 'tesseract.js'

const execFileAsync = promisify(execFile)

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

function mapLanguage(sourceLanguage) {
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

let workersPromise = null
let currentLang = null
let rr = 0

async function getWorkers(langKey) {
  const langStr = Array.isArray(langKey) ? langKey.join('+') : (langKey || 'eng')
  if (workersPromise && currentLang === langStr) {
    return workersPromise
  }
  if (workersPromise) {
    const old = await workersPromise
    await Promise.all(old.map(w => w.terminate().catch(() => {})))
  }
  currentLang = langStr
  workersPromise = (async () => {
    const ws = []
    try {
      for (let i = 0; i < POOL; i++) ws.push(await createWorker(langStr))
    } catch (err) {
      const msg = `Failed to create Tesseract worker for language "${langStr}". `
        + `Ensure the traineddata file is downloaded. `
        + `Original error: ${err.message}`
      throw new Error(msg)
    }
    return ws
  })()
  return workersPromise
}

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

export class TesseractOcr {
  constructor() {
    this.id = 'tesseract'
    this.model = 'tesseract'
  }

  async detectSubtitle({ imagePath, width, height, sourceLanguage }) {
    const w = Number(width) || 1280
    const h = Number(height) || 720

    const langCodes = mapLanguage(sourceLanguage)
    const workers = await getWorkers(langCodes)
    const worker = workers[rr++ % workers.length]

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

      return { boxes, model: this.model, usage: null }
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
