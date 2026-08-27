const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

export class GeminiLlm {
  constructor(apiKey) {
    this.id = 'gemini'
    this.model = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    this.apiKey = apiKey
  }

  async complete({ system, prompt, json = false, temperature = 0.7, maxOutputTokens }) {
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        ...(json ? { response_mime_type: 'application/json' } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      },
    }
    if (system) body.systemInstruction = { parts: [{ text: system }] }

    const res = await fetch(`${BASE}/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      const message = data?.error?.message || `Gemini HTTP ${res.status}`
      throw new Error(`Gemini LLM lỗi: ${message}`)
    }
    const candidate = data.candidates?.[0]
    const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('')
    if (!text.trim()) throw new Error('Gemini trả về nội dung rỗng (có thể do chặn an toàn nội dung)')
    return {
      text,
      model: this.model,
      usage: {
        tokensIn: data.usageMetadata?.promptTokenCount ?? null,
        tokensOut: data.usageMetadata?.candidatesTokenCount ?? null,
      },
    }
  }
}

export default GeminiLlm
