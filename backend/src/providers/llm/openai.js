const BASE = 'https://api.openai.com/v1'

export class OpenAiLlm {
  constructor(apiKey) {
    this.id = 'openai'
    this.model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
    this.apiKey = apiKey
  }

  async complete({ system, prompt, json = false, temperature = 0.7, maxOutputTokens }) {
    if (process.env.NODE_ENV === 'test' && (process.env.DEFAULT_PROVIDER_MODE === 'mock' || process.env.AI_PROVIDER_MODE === 'mock')) {
      const isUnmocked = typeof globalThis.fetch === 'function' && (String(globalThis.fetch).includes('undici') || String(globalThis.fetch).includes('[native code]'))
      if (isUnmocked) {
        throw new Error(`[TestGuard] External call to OpenAI (${this.model}) blocked in test mode. Use MockLlm or mock globalThis.fetch in tests.`)
      }
    }
    const messages = []
    if (system) messages.push({ role: 'system', content: system })
    messages.push({ role: 'user', content: prompt })
    const body = {
      model: this.model,
      messages,
      temperature,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
    }
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      const message = data?.error?.message || `OpenAI HTTP ${res.status}`
      const err = new Error(`OpenAI LLM lỗi: ${message}`)
      err.status = res.status
      throw err
    }
    const text = data.choices?.[0]?.message?.content || ''
    if (!text.trim()) throw new Error('OpenAI trả về nội dung rỗng')
    return {
      text,
      model: data.model || this.model,
      usage: {
        tokensIn: data.usage?.prompt_tokens ?? null,
        tokensOut: data.usage?.completion_tokens ?? null,
      },
    }
  }
}

export default OpenAiLlm
