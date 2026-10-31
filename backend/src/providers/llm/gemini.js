import { generateContent } from '../geminiClient.js'

export class GeminiLlm {
  constructor(apiKey) {
    this.id = 'gemini'
    this.model = process.env.GEMINI_MODEL || 'gemini-3.8-flash'
    this.apiKey = apiKey
  }

  async complete({ system, prompt, json = false, temperature = 0.7, maxOutputTokens, maxRetries, timeoutMs, signal }) {
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        ...(json ? { response_mime_type: 'application/json' } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      },
    }
    if (system) body.systemInstruction = { parts: [{ text: system }] }

    const result = await generateContent({ model: this.model, apiKey: this.apiKey, body, json, maxOutputTokens, label: 'Gemini LLM', maxRetries, timeoutMs, signal })
    if (!result.text.trim()) {
      throw new Error('Gemini tra ve noi dung rong (co the do chan an toan noi dung)')
    }
    return result
  }
}

export default GeminiLlm