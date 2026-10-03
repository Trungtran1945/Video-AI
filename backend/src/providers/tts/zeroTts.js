import fs from 'node:fs'
import path from 'path'
import { probe, ffmpeg } from '../../media/ffmpeg.js'
import { ERROR_CODES } from '../../lib/providerErrors.js'

/**
 * ZeroTts — Local Zero-Shot Text-To-Speech provider powered by ZeroWeight AI / ZeroTTS (ONNX Runtime).
 *
 * Characteristics:
 * - Local inference (CPU-optimized, zero cloud quota/rate-limits).
 * - Persistent service architecture (model loaded once in Python HTTP service).
 * - Keyless provider (no API key required).
 * - Native speed is NOT supported by the upstream model; tempo fitting is performed via FFmpeg (applyTempoAudio).
 */
export class ZeroTts {
  constructor(apiKey) {
    this.id = 'zerotts'
    this.model = process.env.ZEROTTS_MODEL || 'zerotts'
    this.voice = process.env.ZEROTTS_VOICE || 'maichi'
    this.apiKey = null // Keyless provider

    const host = process.env.ZEROTTS_HOST || '127.0.0.1'
    const port = process.env.ZEROTTS_PORT || 5005
    const rawUrl = process.env.ZEROTTS_URL || `http://${host}:${port}`
    this.baseUrl = rawUrl.replace(/\/+$/, '')
    this.timeoutMs = Number(process.env.ZEROTTS_TIMEOUT_MS) || 60000
  }

  /**
   * Health check to verify local ZeroTTS service status and loaded model/voices.
   * @returns {Promise<{ok: boolean, model?: string, voices?: string[], error?: string}>}
   */
  async checkHealth() {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.min(5000, this.timeoutMs))
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
      }).finally(() => clearTimeout(timer))

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        return {
          ok: false,
          status: res.status,
          error: body.error || `HTTP ${res.status}`,
        }
      }
      const data = await res.json()
      return { ok: true, ...data }
    } catch (err) {
      return {
        ok: false,
        error: err.message,
      }
    }
  }

  /**
   * Synthesize text to speech using local ZeroTTS service.
   *
   * @param {object} params
   * @param {string} params.text - Text to synthesize
   * @param {string} params.outPath - Output audio destination path (.mp3 or .wav)
   * @param {number} [params.speed=1] - Requested speed (ZeroTTS uses FFmpeg fitting downstream)
   * @param {string} [params.voice] - Optional voice name override
   * @returns {Promise<{audioPath: string, durationSec: number, provider: string, model: string, usage: object}>}
   */
  async synthesize({ text, outPath, speed = 1, voice }) {
    const cleanText = String(text || '').trim()
    if (!cleanText) {
      const err = new Error('TTS text rỗng')
      err.code = ERROR_CODES.PROVIDER_INVALID_REQUEST
      throw err
    }

    const selectedVoice = voice || this.voice || 'maichi'
    const targetPath = path.resolve(outPath)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })

    const isMp3 = targetPath.toLowerCase().endsWith('.mp3')
    const serviceOutPath = isMp3 ? targetPath + '.tmp.wav' : targetPath

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    let res
    try {
      res = await fetch(`${this.baseUrl}/synthesize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, audio/wav',
        },
        body: JSON.stringify({
          text: cleanText,
          voice: selectedVoice,
          speed: Number(speed) || 1,
          out_path: serviceOutPath,
        }),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      const cause = err.cause
      const causeCode = err.code || cause?.code
      const fullMsg = `${err.message} ${cause?.message || ''}`

      if (err.name === 'AbortError' || causeCode === 'ETIMEDOUT' || /timeout|abort/i.test(fullMsg)) {
        const timeoutErr = new Error(
          `ZeroTTS timeout: không nhận được phản hồi sau ${Math.round(this.timeoutMs / 1000)}s`
        )
        timeoutErr.code = ERROR_CODES.PROVIDER_TIMEOUT
        timeoutErr.status = 504
        throw timeoutErr
      }
      if (causeCode === 'ECONNREFUSED' || /econnrefused/i.test(fullMsg)) {
        const connErr = new Error(
          `ZeroTTS local service không phản hồi (ECONNREFUSED tại ${this.baseUrl}). Hãy khởi động service bằng 'npm run zerotts:start' hoặc kiểm tra biến ZEROTTS_URL.`
        )
        connErr.code = ERROR_CODES.PROVIDER_UNAVAILABLE
        connErr.status = 503
        throw connErr
      }
      const netErr = new Error(`ZeroTTS network error: ${err.message}`)
      netErr.code = ERROR_CODES.PROVIDER_NETWORK_ERROR
      throw netErr
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      const detail = await res.json().catch(() => null)
      const message = detail?.error || `ZeroTTS HTTP ${res.status}`
      const err = new Error(`TTS (ZeroTTS) lỗi: ${message}`)
      err.status = res.status
      if (res.status === 400) {
        err.code = ERROR_CODES.PROVIDER_INVALID_REQUEST
      } else if (res.status === 404) {
        err.code = detail?.code === 'VOICE_NOT_FOUND'
          ? ERROR_CODES.PROVIDER_INVALID_REQUEST
          : ERROR_CODES.PROVIDER_MODEL_NOT_FOUND
      } else if (res.status === 503 || res.status === 500) {
        err.code = ERROR_CODES.PROVIDER_UNAVAILABLE
      }
      throw err
    }

    const contentType = res.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const data = await res.json()
      const actualSaved = data.audioPath || serviceOutPath
      if (!fs.existsSync(actualSaved)) {
        const missingErr = new Error(`ZeroTTS: service báo thành công nhưng không tìm thấy file tại ${actualSaved}`)
        missingErr.code = ERROR_CODES.PROVIDER_UNAVAILABLE
        throw missingErr
      }

      if (isMp3) {
        try {
          await ffmpeg(['-y', '-i', actualSaved, '-c:a', 'libmp3lame', '-q:a', '2', targetPath])
        } catch (_) {
          fs.copyFileSync(actualSaved, targetPath)
        } finally {
          try { fs.unlinkSync(actualSaved) } catch (_) {}
        }
      } else if (actualSaved !== targetPath) {
        fs.renameSync(actualSaved, targetPath)
      }

      const probeInfo = await probe(targetPath)
      const durationSec = data.durationSec || probeInfo.durationSec
      return {
        audioPath: targetPath,
        durationSec,
        provider: this.id,
        model: this.model,
        usage: { durationSec, chars: cleanText.length },
      }
    } else {
      // Binary audio stream from service
      const buffer = Buffer.from(await res.arrayBuffer())
      if (!buffer.length) {
        const emptyErr = new Error('ZeroTTS trả về audio buffer rỗng')
        emptyErr.code = ERROR_CODES.PROVIDER_UNAVAILABLE
        throw emptyErr
      }

      if (targetPath.endsWith('.mp3')) {
        const tmpWav = targetPath + '.tmp.wav'
        fs.writeFileSync(tmpWav, buffer)
        try {
          await ffmpeg(['-y', '-i', tmpWav, '-c:a', 'libmp3lame', '-q:a', '2', targetPath])
        } catch (_) {
          fs.writeFileSync(targetPath, buffer)
        } finally {
          try { fs.unlinkSync(tmpWav) } catch (_) {}
        }
      } else {
        fs.writeFileSync(targetPath, buffer)
      }

      const durationSec = (await probe(targetPath)).durationSec
      return {
        audioPath: targetPath,
        durationSec,
        provider: this.id,
        model: this.model,
        usage: { durationSec, chars: cleanText.length },
      }
    }
  }
}

/**
 * If a file has an .mp3 extension but is actually RIFF/WAV, convert it in-place to MP3.
 */
async function ensureMp3Format(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r')
    const header = Buffer.alloc(4)
    fs.readSync(fd, header, 0, 4, 0)
    fs.closeSync(fd)

    // Check if header starts with 'RIFF' (WAV)
    if (header.toString('ascii') === 'RIFF') {
      const tmpWav = filePath + '.conv.wav'
      fs.renameSync(filePath, tmpWav)
      try {
        await ffmpeg(['-y', '-i', tmpWav, '-c:a', 'libmp3lame', '-q:a', '2', filePath])
      } finally {
        try { fs.unlinkSync(tmpWav) } catch (_) {}
      }
    }
  } catch (_) {
    // If conversion fails or file is already MP3, leave as is
  }
}

export default ZeroTts
