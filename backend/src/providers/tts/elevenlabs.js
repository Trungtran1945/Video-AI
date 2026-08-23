import fs from 'node:fs'
import path from 'path'
import { probe } from '../../media/ffmpeg.js'

const BASE = 'https://api.elevenlabs.io/v1'

export class ElevenLabsTts {
  constructor(apiKey) {
    this.id = 'elevenlabs'
    this.model = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2'
    this.voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'
    this.apiKey = apiKey
  }

  async synthesize({ text, outPath }) {
    const res = await fetch(
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
      }
    )
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      let message = `ElevenLabs HTTP ${res.status}`
      try {
        const parsed = JSON.parse(detail)
        message = parsed?.detail?.message || parsed?.detail?.status || message
      } catch (_) {}
      throw new Error(`TTS (ElevenLabs) lỗi: ${message}`)
    }
    const buffer = Buffer.from(await res.arrayBuffer())
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
