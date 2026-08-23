import fs from 'node:fs'

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

const DEFAULT_PROMPT =
  'Mô tả ngắn gọn cảnh này bằng tiếng Việt trong một câu (bối cảnh, nhân vật, hành động, không đoán tên thật).'

export class GeminiVision {
  constructor(apiKey) {
    this.id = 'gemini'
    this.model = process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || 'gemini-1.5-flash'
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
}

export default GeminiVision
