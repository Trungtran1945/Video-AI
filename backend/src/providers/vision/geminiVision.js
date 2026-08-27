import fs from 'node:fs'

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

const DEFAULT_PROMPT =
  'Mô tả ngắn gọn cảnh này bằng tiếng Việt trong một câu (bối cảnh, nhân vật, hành động, không đoán tên thật).'

export class GeminiVision {
  constructor(apiKey) {
    this.id = 'gemini'
    this.model = process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    this.apiKey = apiKey
  }

  async describeImage({ imagePath, prompt }) {
    const data = fs.readFileSync(imagePath).toString('base64')
    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: 'image/jpeg', data } },
            { text: prompt || DEFAULT_PROMPT },
          ],
        },
      ],
      generationConfig: { temperature: 0.4, maxOutputTokens: 200 },
    }
    const res = await fetch(`${BASE}/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      const message = json?.error?.message || `Gemini Vision HTTP ${res.status}`
      throw new Error(`Vision (Gemini) lỗi: ${message}`)
    }
    const text = (json.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join('')
      .trim()
    return {
      text,
      model: this.model,
      usage: {
        tokensIn: json.usageMetadata?.promptTokenCount ?? null,
        tokensOut: json.usageMetadata?.candidatesTokenCount ?? null,
      },
    }
  }

  // OCR hardsub (docs/05 §B.3): phát hiện vùng phụ đề cứng trong frame.
  // Trả về [{x, y, width, height, text, confidence}] theo pixel khung hình.
  async detectSubtitle({ imagePath, width, height }) {
    const data = fs.readFileSync(imagePath).toString('base64')
    const w = Number(width) || 1280
    const h = Number(height) || 720
    const prompt =
      `Bạn là mô hình OCR chuyên phát hiện PHỤ ĐỀ CỨNG (hardsub) trong ảnh khung hình video ` +
      `kích thước ${w}x${h} pixel. Chỉ quan tâm chữ của PHỤ ĐỆ (thường ở phần dưới khung), ` +
      `BỎ QUA watermark, logo, tên thương hiệu ở góc và chữ nằm trong cảnh phim.\n` +
      `Trả về DUY NHẤT một JSON (không markdown) theo schema:\n` +
      `{"boxes":[{"x":int,"y":int,"width":int,"height":int,"text":string,"confidence":float}]}\n` +
      `Toạ độ tính bằng pixel theo kích thước ${w}x${h}. Không có phụ đề → {"boxes":[]}.`
    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: 'image/jpeg', data } },
            { text: prompt },
          ],
        },
      ],
      generationConfig: { temperature: 0.1, maxOutputTokens: 800, response_mime_type: 'application/json' },
    }
    const res = await fetch(`${BASE}/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      const message = json?.error?.message || `Gemini Vision HTTP ${res.status}`
      throw new Error(`OCR (Gemini) lỗi: ${message}`)
    }
    const raw = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim()
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (_) {
      const m = raw.match(/\{[\s\S]*\}/)
      try { parsed = JSON.parse(m ? m[0] : '') } catch (_) { parsed = null }
    }
    const boxes = Array.isArray(parsed?.boxes)
      ? parsed.boxes
      : Array.isArray(parsed) ? parsed : []
    return {
      boxes: boxes
        .map((b) => ({
          x: clampInt(b.x, 0, w),
          y: clampInt(b.y, 0, h),
          width: clampInt(b.width ?? b.w, 1, w),
          height: clampInt(b.height ?? b.h, 1, h),
          text: String(b.text || ''),
          confidence: Number.isFinite(Number(b.confidence)) ? Number(b.confidence) : 0.6,
        }))
        .filter((b) => b.width > 4 && b.height > 4),
      model: this.model,
      usage: {
        tokensIn: json.usageMetadata?.promptTokenCount ?? null,
        tokensOut: json.usageMetadata?.candidatesTokenCount ?? null,
      },
    }
  }
}

function clampInt(v, min, max) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

export default GeminiVision
