import fs from 'node:fs'
import path from 'path'
import { probe } from '../../media/ffmpeg.js'
import { ERROR_CODES, ERROR_KINDS } from '../../lib/providerErrors.js'

const BASE = 'https://api.elevenlabs.io/v1'

function getElevenLabsTimeoutMs() {
  const v = Number(process.env.ELEVENLABS_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 60_000
}

export class ElevenLabsTts {
  constructor(apiKey) {
    this.id = 'elevenlabs'
    this.model = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2'
    this.voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'
    this.apiKey = apiKey
  }

  async synthesize({ text, outPath }) {
    const timeoutMs = getElevenLabsTimeoutMs()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res
    let buffer
    try {
      res = await fetch(
        `${BASE}/text-to-speech/${this.voiceId}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            model_id: this.model,
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
          signal: controller.signal,
        }
      )
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        let message = `ElevenLabs HTTP ${res.status}`
        try {
          const parsed = JSON.parse(detail)
          message = parsed?.detail?.message || parsed?.detail?.status || message
        } catch (_) {}
        const err = new Error(`TTS (ElevenLabs) lỗi: ${message}`)
        err.status = res.status
        throw err
      }
      buffer = Buffer.from(await res.arrayBuffer())
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || controller.signal.aborted) {
        const terr = new Error(`TTS (ElevenLabs) timeout sau ${Math.round(timeoutMs / 1000)}s`)
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
      provider: 'elevenlabs',
      model: this.model,
      usage: { durationSec, chars: text.length },
    }
  }
}

export default ElevenLabsTts
