import fs from 'node:fs'
import path from 'path'
import crypto from 'node:crypto'
import WebSocket from 'ws'
import { probe } from '../../media/ffmpeg.js'

// Edge-TTS (dịch vụ Read Aloud của Microsoft Edge) — miễn phí, không cần API key.
// Giao thức WebSocket + token Sec-MS-GEC (SHA256 theo tick Windows, làm tròn 5 phút).
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const WSS_URL =
  `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
  `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
const CHROMIUM_FULL_VERSION = '130.0.2849.68'
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'
const REQUEST_TIMEOUT_MS = 30000

export class EdgeTts {
  constructor(_apiKey) {
    this.id = 'edge_tts'
    this.voice = process.env.EDGE_TTS_VOICE || 'vi-VN-NamMinhNeural'
    this.model = this.voice
    this.apiKey = null // không cần key
  }

  async synthesize({ text, outPath, speed = 1 }) {
    const buffer = await synthesizeBuffer(text, this.voice, speed)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, buffer)
    const durationSec = (await probe(outPath)).durationSec
    return {
      audioPath: outPath,
      durationSec,
      provider: this.id,
      model: this.voice,
      usage: { durationSec, chars: text.length },
    }
  }
}

function secMsGecToken() {
  // Tick Windows: số khoảng 100ns từ 1601-01-01, làm tròn xuống bội 300s
  let ticks = Math.floor(Date.now() / 1000) + 11644473600
  ticks -= ticks % 300
  ticks *= 1e7
  return crypto.createHash('sha256').update(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase()
}

function buildUrl() {
  return `${WSS_URL}&Sec-MS-GEC=${secMsGecToken()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
}

function ssmlFor(text, voice, speed) {
  const lang = voice.split('-').slice(0, 2).join('-') || 'en-US'
  const pct = Math.round((Number(speed) || 1) * 100)
  const rate = `${pct >= 100 ? '+' : '-'}${Math.abs(pct - 100)}%`
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
    `<voice name='${voice}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>${escaped}</prosody></voice></speak>`
  )
}

function connectMessage(requestId) {
  const dateStr =
    new Date().toUTCString().replace(/GMT$/, 'GMT+0000 (Coordinated Universal Time)')
  return (
    `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${dateStr}\r\nPath:ssml\r\n\r\n`
  )
}

function configMessage() {
  const dateStr =
    new Date().toUTCString().replace(/GMT$/, 'GMT+0000 (Coordinated Universal Time)')
  const payload = JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
          outputFormat: OUTPUT_FORMAT,
        },
      },
    },
  })
  return (
    `X-Timestamp:${dateStr}\r\nContent-Type:application/json; charset=utf-8\r\n` +
    `Path:speech.config\r\n\r\n${payload}`
  )
}

async function synthesizeOnce(text, voice, speed) {
  return new Promise((resolve, reject) => {
    let ws
    try {
      ws = new WebSocket(buildUrl(), {
        headers: {
          Origin: 'chrome-extension://jdiccldimpahbcfhbmnnjbclgnbnkgof',
          'User-Agent':
            `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
            `Chrome/${CHROMIUM_FULL_VERSION.split('.').slice(0, 3).join('.')} Safari/537.36 Edg/${CHROMIUM_FULL_VERSION}`,
        },
      })
    } catch (err) {
      reject(err)
      return
    }

    const chunks = []
    let finished = false
    const timer = setTimeout(() => {
      finish(new Error('Edge TTS timeout: không nhận được âm thanh sau 30s'))
    }, REQUEST_TIMEOUT_MS)

    function finish(err) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      try { ws?.close() } catch (_) {}
      if (err) reject(err)
      else resolve(Buffer.concat(chunks))
    }

    ws.on('open', () => {
      const requestId = crypto.randomUUID().replace(/-/g, '')
      ws.send(configMessage())
      ws.send(connectMessage(requestId) + ssmlFor(text, voice, speed))
    })

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const msg = data.toString()
        if (msg.includes('Path:turn.end')) finish(null)
        return
      }
      // Binary: 2 byte đầu (big-endian) là độ dài header, phần sau là dữ liệu audio
      if (data.length < 2) return
      const headerLen = data.readUInt16BE(0)
      const header = data.slice(2, 2 + headerLen).toString()
      if (header.includes('Path:audio')) {
        chunks.push(data.slice(2 + headerLen))
      }
    })

    ws.on('error', (err) => finish(err))
    ws.on('close', () => {
      if (!finished) {
        if (chunks.length) finish(null)
        else finish(new Error('Edge TTS đóng kết nối trước khi trả âm thanh'))
      }
    })
  })
}

async function synthesizeBuffer(text, voice, speed) {
  try {
    return await synthesizeOnce(text, voice, speed)
  } catch (err) {
    // Token Sec-MS-GEC có thể hết hạn giữa chừng → thử lại đúng 1 lần với token mới
    try {
      return await synthesizeOnce(text, voice, speed)
    } catch (_) {
      throw new Error(`TTS (Edge) lỗi: ${err.message}`)
    }
  }
}

export default EdgeTts
