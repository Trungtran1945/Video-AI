import fs from 'node:fs'
import path from 'path'
import { probe } from '../../media/ffmpeg.js'

const BASE = 'https://api.openai.com/v1'

export class OpenAiTts {
  constructor(apiKey) {
    this.id = 'openai_tts'
    this.model = process.env.OPENAI_TTS_MODEL || 'tts-1'
    this.voice = process.env.OPENAI_TTS_VOICE || 'alloy'
    this.apiKey = apiKey
  }

  async synthesize({ text, outPath, speed = 1 }) {
    const res = await fetch(`${BASE}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice: this.voice,
        response_format: 'mp3',
        speed: Math.min(2, Math.max(0.5, speed)),
      }),
    })
    if (!res.ok) {
      const detail = await res.json().catch(() => null)
      const message = detail?.error?.message || `OpenAI TTS HTTP ${res.status}`
      throw new Error(`TTS (OpenAI) lỗi: ${message}`)
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, buffer)
    const durationSec = (await probe(outPath)).durationSec
    return {
      audioPath: outPath,
      durationSec,
      provider: 'openai_tts',
      model: this.model,
      usage: { durationSec, chars: text.length },
    }
  }
}

export default OpenAiTts
