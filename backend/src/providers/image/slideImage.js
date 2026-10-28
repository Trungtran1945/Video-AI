import crypto from 'node:crypto'
import fs from 'node:fs'
import { writeBmp, isBmpFile } from '../../lib/bmp.js'

// Deterministic local "slide" image provider (MVP): gradient background plus
// accent bars derived from sha256(prompt + seed). It is NOT AI image
// generation — the UI labels it as an internal slide. No API key, no network.

function digestOf(input) {
  return crypto.createHash('sha256').update(String(input)).digest()
}

function pickPalette(digest) {
  // Derive a small dark palette from hash bytes, keeping text overlays legible.
  const hue = digest[0] / 255
  const accent = {
    r: 40 + Math.round(digest[1] * 0.6),
    g: 40 + Math.round(digest[2] * 0.6),
    b: 40 + Math.round(digest[3] * 0.6),
  }
  const base = {
    r: Math.round(12 + hue * 18),
    g: Math.round(16 + hue * 22),
    b: Math.round(30 + hue * 26),
  }
  const secondary = {
    r: Math.min(255, base.r + 18 + Math.round(digest[4] * 0.25)),
    g: Math.min(255, base.g + 20 + Math.round(digest[5] * 0.25)),
    b: Math.min(255, base.b + 26 + Math.round(digest[6] * 0.25)),
  }
  return { base, secondary, accent }
}

function pixelFactory(digest) {
  const { base, secondary, accent } = pickPalette(digest)
  const bars = []
  const barCount = 2 + (digest[7] % 3)
  for (let i = 0; i < barCount; i++) {
    const seed = digest[8 + i * 5] ?? 0
    const widthRatio = 0.04 + ((digest[9 + i * 5] ?? 0) / 255) * 0.12
    const xRatio = ((digest[10 + i * 5] ?? 0) / 255) * (1 - widthRatio)
    const topRatio = 0.08 + ((digest[11 + i * 5] ?? 0) / 255) * 0.55
    bars.push({ xRatio, widthRatio, topRatio, alpha: 0.25 + (seed / 255) * 0.45 })
  }
  const blockSeed = digest[12] ?? 0
  const block = {
    x3: 0.58 + ((digest[13] ?? 0) / 255) * 0.2,
    y3: 0.12 + ((digest[14] ?? 0) / 255) * 0.2,
    s3: 0.14 + (blockSeed / 255) * 0.18,
  }

  return (x, y, w, h) => {
    const fx = x / w
    const fy = y / h
    // Diagonal gradient base.
    const t = Math.min(1, Math.max(0, (fx + fy) / 2))
    let r = base.r + (secondary.r - base.r) * t
    let g = base.g + (secondary.g - base.g) * t
    let b = base.b + (secondary.b - base.b) * t

    for (const bar of bars) {
      if (fx >= bar.xRatio && fx <= bar.xRatio + bar.widthRatio && fy >= bar.topRatio) {
        r = r + (accent.r - r) * bar.alpha
        g = g + (accent.g - g) * bar.alpha
        b = b + (accent.b - b) * bar.alpha
      }
    }
    if (fx >= block.x3 && fx <= block.x3 + block.s3 && fy >= block.y3 && fy <= block.y3 + block.s3) {
      r = r * 0.55 + accent.r * 0.45
      g = g * 0.55 + accent.g * 0.45
      b = b * 0.55 + accent.b * 0.45
    }
    // Vignette keeps the frame from looking flat.
    const dx = fx - 0.5
    const dy = fy - 0.5
    const vignette = 1 - Math.min(0.35, (dx * dx + dy * dy) * 0.6)
    return {
      r: Math.max(0, Math.min(255, Math.round(r * vignette))),
      g: Math.max(0, Math.min(255, Math.round(g * vignette))),
      b: Math.max(0, Math.min(255, Math.round(b * vignette))),
    }
  }
}

export class SlideImage {
  constructor({ mock = false } = {}) {
    this.id = mock ? 'mock' : 'slide'
    this.model = 'slide-bmp-v1'
    this.isMock = mock
  }

  async generate({ prompt = '', text = '', width = 960, height = 540, outPath, previewPath, seed = '' }) {
    if (!outPath) throw new Error('SLIDE_OUTPATH_REQUIRED')
    const digest = digestOf(`${prompt}\n${text}\n${seed}`)
    const pixelAt = pixelFactory(digest)
    writeBmp(outPath, { pixelAt, width, height })

    let preview = null
    if (previewPath) {
      const pw = Math.max(2, Math.round(width / 3))
      const ph = Math.max(2, Math.round(height / 3))
      writeBmp(previewPath, { pixelAt: pixelFactory(digest), width: pw, height: ph })
      preview = previewPath
    }

    if (!isBmpFile(outPath)) throw new Error('SLIDE_INVALID_OUTPUT')
    return {
      imagePath: outPath,
      previewPath: preview,
      width,
      height,
      mime: 'image/bmp',
      provider: this.id,
      seed,
      promptHash: digest.toString('hex'),
    }
  }

  async close() {
    try { if (this._tmp) fs.rmSync(this._tmp, { recursive: true, force: true }) } catch (_) {}
  }
}

export default SlideImage
