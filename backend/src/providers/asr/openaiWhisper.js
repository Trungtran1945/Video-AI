import fs from 'node:fs'
import path from 'path'

const BASE = 'https://api.openai.com/v1'

export class OpenAiWhisperAsr {
  constructor(apiKey) {
    this.id = 'whisper'
    this.model = process.env.WHISPER_MODEL || 'whisper-1'
    this.apiKey = apiKey
  }

  async transcribe(filePath, { language } = {}) {
    const buffer = fs.readFileSync(filePath)
    const form = new FormData()
    form.append('file', new Blob([buffer]), path.basename(filePath))
    form.append('model', this.model)
    form.append('response_format', 'verbose_json')
    if (language) form.append('language', language)

    const res = await fetch(`${BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      const message = data?.error?.message || `OpenAI Whisper HTTP ${res.status}`
      throw new Error(`ASR (Whisper) lỗi: ${message}`)
    }
    const segments = (data.segments || []).map((s) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: String(s.text || '').trim(),
    })).filter((s) => s.text)
    const durationSec = segments.length ? segments[segments.length - 1].end : Number(data.duration) || 0
    return {
      language: data.language || language || 'unknown',
      durationSec,
      segments,
      model: this.model,
      usage: { durationSec },
    }
  }
}

export default OpenAiWhisperAsr
