import fs from 'node:fs'
import path from 'path'
import { probe, ffmpeg } from '../../media/ffmpeg.js'
import { ERROR_CODES } from '../../lib/providerErrors.js'

/**
 * VoiceStudio — Local Offline Text-To-Speech provider powered by debpalash/VoiceStudio
 * (OpenAI-compatible speech API: POST /v1/audio/speech).
 *
 * Characteristics:
 * - Local inference (offline, keyless, zero cloud quota limits).
 * - Standard endpoint: POST /v1/audio/speech (model: 'tts-1', voice, input, response_format, speed).
 * - Health check: GET /health (or GET /v1/audio/voices).
 * - Port default: 3900 (http://127.0.0.1:3900 or http://voicestudio:3900 in Docker).
 * - Audio fail-closed verification: valid container, non-empty buffer, ffprobe verification.
 */
export class VoiceStudio {
  constructor(apiKey) {
    this.id = 'voicestudio'
    this.model = process.env.VOICESTUDIO_MODEL || 'tts-1'
    this.voice = process.env.VOICESTUDIO_VOICE || 'default'
    this.apiKey = apiKey || process.env.VOICESTUDIO_API_KEY || null

    const host = process.env.VOICESTUDIO_HOST || '127.0.0.1'
    const port = process.env.VOICESTUDIO_PORT || 3900
    const rawUrl = process.env.VOICESTUDIO_URL || `http://${host}:${port}`
    this.baseUrl = rawUrl.replace(/\/+$/, '')
    this.timeoutMs = Number(process.env.VOICESTUDIO_TIMEOUT_MS) || 60000
    const readyWait = Number(process.env.VOICESTUDIO_READY_WAIT_MS)
    this.readyWaitMs = Number.isFinite(readyWait) && readyWait > 0 ? readyWait : 60000
  }

  /**
   * Health check to verify local VoiceStudio service status.
   * @returns {Promise<{ok: boolean, status?: number, voices?: string[], error?: string}>}
   */
  async checkHealth() {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.min(5000, this.timeoutMs))
      const headers = { Accept: 'application/json' }
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`

      const res = await fetch(`${this.baseUrl}/health`, {
        headers,
        signal: controller.signal,
      }).finally(() => clearTimeout(timer))

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        return {
          ok: false,
          status: res.status,
          error: body.error || body.message || `HTTP ${res.status}`,
        }
      }
      const data = await res.json().catch(() => ({ status: 'ok' }))
      return { ok: true, status: res.status, ...data }
    } catch (err) {
      return {
        ok: false,
        error: err.message,
      }
    }
  }

  /**
   * Bounded readiness wait for VoiceStudio.
   * @param {number} [timeoutMs=this.readyWaitMs]
   * @param {AbortSignal|null} [signal]
   * @returns {Promise<boolean>}
   */
  async waitForReady(timeoutMs = this.readyWaitMs, signal = null) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
    let sawLoading = false
    for (;;) {
      if (signal?.aborted) return false
      const health = await this.checkHealth()
      if (health.ok) return true
      if (health.status !== 503) return false
      if (!sawLoading) {
        sawLoading = true
        console.log(`[VoiceStudio] service đang khởi động tại ${this.baseUrl} — chờ tối đa ${Math.max(0, Number(timeoutMs) || 0)}ms`)
      }
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 750))
    }
  }

  /**
   * Synthesize text to speech using VoiceStudio OpenAI-compatible endpoint.
   *
   * @param {object} params
   * @param {string} params.text - Text to synthesize
   * @param {string} params.outPath - Output audio destination path (.mp3 or .wav)
   * @param {number} [params.speed=1] - Requested speed
   * @param {string} [params.voice] - Voice override
   * @param {string} [params.model] - Model override
   * @param {string} [params.language] - Target language
   * @returns {Promise<{audioPath: string, durationSec: number, provider: string, model: string, usage: object}>}
   */
  async synthesize({ text, outPath, speed = 1, voice, model, language }) {
    const cleanText = String(text || '').trim()
    if (!cleanText) {
      const err = new Error('TTS text rỗng')
      err.code = ERROR_CODES.PROVIDER_INVALID_REQUEST
      throw err
    }

    const selectedVoice = voice || this.voice || 'default'
    const selectedModel = model || this.model || 'tts-1'
    const targetPath = path.resolve(outPath)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })

    const isMp3 = targetPath.toLowerCase().endsWith('.mp3')
    const responseFormat = isMp3 ? 'mp3' : 'wav'

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    const headers = {
      'Content-Type': 'application/json',
      Accept: 'audio/wav, audio/mpeg, audio/mp3, application/json',
    }
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    }

    let res
    try {
      res = await fetch(`${this.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: selectedModel,
          input: cleanText,
          voice: selectedVoice,
          response_format: responseFormat,
          speed: Number(speed) || 1,
          language: language || undefined,
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
          `VoiceStudio timeout: không nhận được phản hồi sau ${Math.round(this.timeoutMs / 1000)}s`
        )
        timeoutErr.code = ERROR_CODES.PROVIDER_TIMEOUT
        timeoutErr.status = 504
        throw timeoutErr
      }
      if (causeCode === 'ECONNREFUSED' || /econnrefused/i.test(fullMsg)) {
        const connErr = new Error(
          `VoiceStudio local service không phản hồi (ECONNREFUSED tại ${this.baseUrl}). Hãy khởi chạy VoiceStudio tại cổng 3900 (VD: docker run -d -p 127.0.0.1:3900:3900 ghcr.io/debpalash/voicestudio:stable) hoặc kiểm tra biến VOICESTUDIO_URL.`
        )
        connErr.code = ERROR_CODES.PROVIDER_UNAVAILABLE
        connErr.status = 503
        throw connErr
      }
      const netErr = new Error(`VoiceStudio network error: ${err.message}`)
      netErr.code = ERROR_CODES.PROVIDER_NETWORK_ERROR
      throw netErr
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      const detail = await res.json().catch(() => null)
      const message = detail?.error?.message || detail?.detail || detail?.error || `VoiceStudio HTTP ${res.status}`
      const err = new Error(`TTS (VoiceStudio) lỗi: ${message}`)
      err.status = res.status
      if (res.status === 400 || res.status === 422) {
        err.code = ERROR_CODES.PROVIDER_INVALID_REQUEST
      } else if (res.status === 404) {
        err.code = ERROR_CODES.PROVIDER_MODEL_NOT_FOUND
      } else if (res.status === 429) {
        err.code = ERROR_CODES.PROVIDER_RATE_LIMITED
      } else if (res.status >= 500) {
        err.code = ERROR_CODES.PROVIDER_UNAVAILABLE
      }
      throw err
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    if (contentType.includes('application/json')) {
      const data = await res.json()
      const actualSaved = data.audioPath || data.filePath || targetPath
      if (!fs.existsSync(actualSaved)) {
        const missingErr = new Error(`VoiceStudio: service báo thành công nhưng không tìm thấy file tại ${actualSaved}`)
        missingErr.code = ERROR_CODES.PROVIDER_UNAVAILABLE
        throw missingErr
      }
      const probeInfo = await probe(actualSaved)
      const durationSec = data.durationSec || probeInfo.durationSec
      return {
        audioPath: actualSaved,
        durationSec,
        provider: this.id,
        model: selectedModel,
        usage: { durationSec, chars: cleanText.length },
      }
    }

    // Binary audio stream
    const buffer = Buffer.from(await res.arrayBuffer())
    if (!buffer.length) {
      const emptyErr = new Error('VoiceStudio trả về audio buffer rỗng')
      emptyErr.code = ERROR_CODES.PROVIDER_UNAVAILABLE
      throw emptyErr
    }

    if (isMp3) {
      const isRiffWav = buffer.toString('ascii', 0, 4) === 'RIFF'
      if (isRiffWav) {
        const tmpWav = targetPath + '.tmp.wav'
        fs.writeFileSync(tmpWav, buffer)
        try {
          await ffmpeg(['-y', '-i', tmpWav, '-c:a', 'libmp3lame', '-q:a', '2', targetPath])
        } catch (convErr) {
          try { fs.unlinkSync(targetPath) } catch (_) {}
          const failErr = new Error(`VoiceStudio MP3 convert thất bại: ${convErr.message}`)
          failErr.code = ERROR_CODES.PROVIDER_UNAVAILABLE
          throw failErr
        } finally {
          try { fs.unlinkSync(tmpWav) } catch (_) {}
        }
      } else {
        fs.writeFileSync(targetPath, buffer)
      }
      await assertRealMp3(targetPath)
    } else {
      fs.writeFileSync(targetPath, buffer)
    }

    const durationSec = (await probe(targetPath)).durationSec
    return {
      audioPath: targetPath,
      durationSec,
      provider: this.id,
      model: selectedModel,
      usage: { durationSec, chars: cleanText.length },
    }
  }
}

/**
 * Validate that MP3 file is genuine.
 */
async function assertRealMp3(filePath) {
  let header = Buffer.alloc(3)
  try {
    const fd = fs.openSync(filePath, 'r')
    try { fs.readSync(fd, header, 0, 3, 0) } finally { fs.closeSync(fd) }
  } catch (readErr) {
    const err = new Error(`VoiceStudio: không đọc được MP3 output: ${readErr.message}`)
    err.code = ERROR_CODES.PROVIDER_RESPONSE_MALFORMED
    throw err
  }
  if (header.toString('ascii', 0, 4) === 'RIFF' || header.toString('ascii', 0, 3) === 'RIF') {
    const err = new Error('VoiceStudio trả về WAV đội lốt .mp3 (header RIFF) — từ chối fail-closed')
    err.code = ERROR_CODES.PROVIDER_RESPONSE_MALFORMED
    throw err
  }
  try {
    const info = await probe(filePath)
    const fmt = String(info?.formatName || '').toLowerCase()
    if (!fmt.includes('mp3')) {
      const err = new Error(`VoiceStudio MP3 validate thất bại (format=${info?.formatName || 'unknown'})`)
      err.code = ERROR_CODES.PROVIDER_RESPONSE_MALFORMED
      throw err
    }
  } catch (err) {
    if (err?.code && String(err.code).startsWith('PROVIDER_')) throw err
    const wrap = new Error(`VoiceStudio MP3 validate thất bại: ${err.message}`)
    wrap.code = ERROR_CODES.PROVIDER_RESPONSE_MALFORMED
    throw wrap
  }
}

export default VoiceStudio
