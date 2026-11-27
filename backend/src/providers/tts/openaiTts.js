import fs from 'node:fs'
import path from 'path'
import { probe } from '../../media/ffmpeg.js'
import { ERROR_CODES, ERROR_KINDS } from '../../lib/providerErrors.js'

const BASE = 'https://api.openai.com/v1'

function getOpenAiTtsTimeoutMs() {
  const v = Number(process.env.OPENAI_TTS_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 60_000
}

export class OpenAiTts {
  constructor(apiKey) {
    this.id = 'openai_tts'
    this.model = process.env.OPENAI_TTS_MODEL || 'tts-1'
    this.voice = process.env.OPENAI_TTS_VOICE || 'alloy'
    this.apiKey = apiKey
  }

  async synthesize({ text, outPath, speed = 1 }) {
    const timeoutMs = getOpenAiTtsTimeoutMs()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res
    let buffer
    try {
      res = await fetch(`${BASE}/audio/speech`, {
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
        signal: controller.signal,
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => null)
        const message = detail?.error?.message || `OpenAI TTS HTTP ${res.status}`
        const err = new Error(`TTS (OpenAI) lỗi: ${message}`)
        err.status = res.status
        throw err
      }
      buffer = Buffer.from(await res.arrayBuffer())
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || controller.signal.aborted) {
        const terr = new Error(`TTS (OpenAI) timeout sau ${Math.round(timeoutMs / 1000)}s`)
        terr.code = ERROR_CODES.PROVIDER_TIMEOUT
        terr.errorCode = ERROR_CODES.PROVIDER_TIMEOUT
        terr.kind = ERROR_KINDS.TRANSIENT
        terr.status = 504
        terr.retryable = true
        throw terr
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
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
