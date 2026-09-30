import fs from 'node:fs'
import path from 'path'

// Tương thích OpenAI Whisper API — có thể trỏ sang Groq free qua WHISPER_BASE_URL
export const DEFAULT_BASE = 'https://api.openai.com/v1'
export const WHISPER_RESPONSE_FORMAT = 'verbose_json'

export function getWhisperEndpoint() {
  const raw = String(process.env.WHISPER_BASE_URL || DEFAULT_BASE).trim() || DEFAULT_BASE
  // Endpoint identity for cache semantics: normalize trailing slash only.
  // Never includes API keys/secrets (they live in Authorization header).
  return raw.replace(/\/+$/, '')
}

export function getWhisperEffectiveModel() {
  return String(process.env.WHISPER_MODEL || 'whisper-1').trim() || 'whisper-1'
}

function normalizeWhisperLanguage(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw || raw === 'auto' || raw === 'unknown') return undefined
  const base = raw.replace(/_/g, '-').split('-')[0]
  if (!/^[a-z]{2,3}$/.test(base)) return undefined
  return base
}

export function whisperTemperature() {
  const raw = Number(process.env.WHISPER_TEMPERATURE ?? 0)
  if (!Number.isFinite(raw)) return 0
  return Math.min(1, Math.max(0, raw))
}

export function whisperPrompt() {
  const raw = String(process.env.WHISPER_INITIAL_PROMPT ?? '').trim()
  return raw || undefined
}

// Effective Whisper request semantics for ASR cache identity.
// Includes everything that changes transcription output; excludes secrets
// (API key lives only in Authorization header, never in cache input).
export function getWhisperEffectiveConfig({ prompt, temperature } = {}) {
  const temp = temperature ?? whisperTemperature()
  const initialPrompt = String(prompt ?? whisperPrompt() ?? '').trim().slice(0, 224) || ''
  return {
    model: getWhisperEffectiveModel(),
    temperature: Number(temp),
    initialPrompt,
    responseFormat: WHISPER_RESPONSE_FORMAT,
    endpoint: getWhisperEndpoint(),
  }
}

export class OpenAiWhisperAsr {
  constructor(apiKey) {
    this.id = 'whisper'
    this.model = getWhisperEffectiveModel()
    this.apiKey = apiKey
  }

  async transcribe(filePath, { language, prompt, temperature } = {}) {
    // Upload memory audit (Node 22): single buffered read for multipart upload.
    // Hashing is streaming (sttUtils.hashFileContent) so this is the only
    // whole-file buffer. File-backed FormData/File (openAsBlob) is not used:
    // no stable file-backed multipart path in Node 22 without experimental
    // APIs; chunk slices here are small compressed MP3s. No memory regression
    // vs prior behavior; do not switch to experimental APIs without re-audit.
    const buffer = fs.readFileSync(filePath)
    const effective = getWhisperEffectiveConfig({ prompt, temperature })
    // Refresh model so mid-process WHISPER_MODEL changes are honored.
    this.model = effective.model
    const base = effective.endpoint
    const form = new FormData()
    form.append('file', new Blob([buffer]), path.basename(filePath))
    form.append('model', effective.model)
    form.append('response_format', effective.responseFormat)
    const lang = normalizeWhisperLanguage(language)
    if (lang) form.append('language', lang)
    form.append('temperature', String(effective.temperature))
    if (effective.initialPrompt) form.append('prompt', effective.initialPrompt)

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
