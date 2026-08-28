import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import gTTS from 'gtts'
import { probe } from '../../media/ffmpeg.js'

// Google Translate TTS (gtts) — miễn phí, không cần API key.
// Dùng làm phương án thay thế khi ElevenLabs/OpenAI chưa cấu hình key.
export class GoogleTts {
  constructor(_apiKey) {
    this.id = 'google_tts'
    this.voice = process.env.GOOGLE_TTS_LANG || 'vi'
    this.model = this.voice
    this.apiKey = null // không cần key
  }

  async synthesize({ text, outPath, speed = 1, lang }) {
    const language = lang || this.voice
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    await saveWithRetry(String(text || ''), language, outPath)
    const durationSec = (await probe(outPath)).durationSec
    return {
      audioPath: outPath,
      durationSec,
      provider: this.id,
      model: language,
      usage: { durationSec, chars: String(text || '').length },
    }
  }
}

function saveWithRetry(text, lang, outPath, attempts = 3) {
  return new Promise((resolve, reject) => {
    const tryOnce = (n) => {
      const tts = new gTTS(text, lang)
      tts.save(outPath, (err) => {
        if (!err) return resolve()
        if (n <= 1) return reject(new Error(`TTS (Google) lỗi: ${err.message}`))
        setTimeout(() => tryOnce(n - 1), 400)
      })
    }
    tryOnce(attempts)
  })
}

export default GoogleTts
