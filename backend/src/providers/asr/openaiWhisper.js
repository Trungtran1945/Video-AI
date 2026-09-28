import fs from 'node:fs'
import path from 'path'

// Tương thích OpenAI Whisper API — có thể trỏ sang Groq free qua WHISPER_BASE_URL
const DEFAULT_BASE = 'https://api.openai.com/v1'

function normalizeWhisperLanguage(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw || raw === 'auto' || raw === 'unknown') return undefined
  const base = raw.replace(/_/g, '-').split('-')[0]
  if (!/^[a-z]{2,3}$/.test(base)) return undefined
  return base
}

function whisperTemperature() {
  const raw = Number(process.env.WHISPER_TEMPERATURE ?? 0)
  if (!Number.isFinite(raw)) return 0
  return Math.min(1, Math.max(0, raw))
}

function whisperPrompt() {
  const raw = String(process.env.WHISPER_INITIAL_PROMPT ?? '').trim()
  return raw || undefined
}

export class OpenAiWhisperAsr {
  constructor(apiKey) {
    this.id = 'whisper'
    this.model = process.env.WHISPER_MODEL || 'whisper-1'
    this.apiKey = apiKey
  }

  async transcribe(filePath, { language, prompt, temperature } = {}) {
    const buffer = fs.readFileSync(filePath)
    const base = process.env.WHISPER_BASE_URL || DEFAULT_BASE
    const form = new FormData()
    form.append('file', new Blob([buffer]), path.basename(filePath))
    form.append('model', this.model)
    form.append('response_format', 'verbose_json')
    const lang = normalizeWhisperLanguage(language)
    if (lang) form.append('language', lang)
    const temp = temperature ?? whisperTemperature()
    form.append('temperature', String(temp))
    const initialPrompt = String(prompt ?? whisperPrompt() ?? '').trim()
    if (initialPrompt) form.append('prompt', initialPrompt.slice(0, 224))

    const res = await fetch(`${base}/audio/transcriptions`, {
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
      noSpeechProb: Number(s.no_speech_prob ?? s.noSpeechProb ?? NaN),
      avgLogprob: Number(s.avg_logprob ?? s.avgLogprob ?? NaN),
    })).filter((s) => s.text)
    for (const s of segments) {
      if (!Number.isFinite(s.noSpeechProb)) delete s.noSpeechProb
      if (!Number.isFinite(s.avgLogprob)) delete s.avgLogprob
    }
    const durationSec = segments.length ? segments[segments.length - 1].end : Number(data.duration) || 0
    return {
      language: normalizeWhisperLanguage(data.language) || lang || 'unknown',
      durationSec,
      segments,
      model: this.model,
      usage: { durationSec },
    }
  }
}

export default OpenAiWhisperAsr
