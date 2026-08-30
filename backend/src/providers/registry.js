import { query, queryOne } from '../db/query.js'
import { decrypt } from '../lib/crypto.js'
import GeminiLlm from './llm/gemini.js'
import OpenAiLlm from './llm/openai.js'
import OpenAiWhisperAsr from './asr/openaiWhisper.js'
import ElevenLabsTts from './tts/elevenlabs.js'
import OpenAiTts from './tts/openaiTts.js'
import EdgeTts from './tts/edgeTts.js'
import GoogleTts from './tts/googleTts.js'
import GeminiVision from './vision/geminiVision.js'
import TesseractOcr from './vision/tesseractOcr.js'

export class ProviderError extends Error {
  constructor(message, code = 'PROV_001') {
    super(message)
    this.code = code
  }
}

export const PROVIDER_LABELS = {
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  huggingface: 'HuggingFace',
  whisper: 'OpenAI Whisper',
  faster_whisper: 'Faster Whisper (local)',
  openai_whisper: 'OpenAI Whisper API',
  elevenlabs: 'ElevenLabs',
  openai_tts: 'OpenAI TTS',
  edge_tts: 'Edge TTS (miễn phí)',
  google_tts: 'Google TTS (miễn phí)',
  google_tts: 'Google TTS',
  azure_speech: 'Azure Speech',
  clip: 'CLIP (local)',
  tesseract: 'Tesseract (local, miễn phí)',
}

// Mỗi provider có thể có nhiều biến môi trường fallback (thử theo thứ tự).
const ENV_KEYS = {
  gemini: ['GEMINI_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  huggingface: ['HUGGINGFACE_TOKEN'],
  // Whisper tương thích OpenAI — Groq free dùng key riêng, OpenAI là fallback cuối
  whisper: ['WHISPER_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY'],
  openai_whisper: ['WHISPER_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY'],
  elevenlabs: ['ELEVENLABS_API_KEY'],
  openai_tts: ['OPENAI_API_KEY'],
}

// Provider chạy không cần API key (Edge-TTS của Microsoft, Tesseract local).
const KEYLESS = new Set(['edge_tts', 'google_tts', 'tesseract'])

const REGISTRY = {
  llm: {
    gemini: (key) => new GeminiLlm(key),
    openai: (key) => new OpenAiLlm(key),
    anthropic: null,
    huggingface: null,
  },
  asr: {
    whisper: (key) => new OpenAiWhisperAsr(key),
    openai_whisper: (key) => new OpenAiWhisperAsr(key),
    faster_whisper: null,
  },
  tts: {
    edge_tts: (key) => new EdgeTts(key),
    elevenlabs: (key) => new ElevenLabsTts(key),
    openai_tts: (key) => new OpenAiTts(key),
    google_tts: (key) => new GoogleTts(key),
    azure_speech: null,
  },
  vision: {
    gemini: (key) => new GeminiVision(key),
    clip: null,
  },
  // OCR hardsub (docs/05 §B.3): Gemini Vision (cần key) hoặc Tesseract local (keyless).
  ocr: {
    gemini: (key) => new GeminiVision(key),
    tesseract: () => new TesseractOcr(),
    paddleocr: null,
  },
}

const DEFAULTS = { llm: 'gemini', asr: 'whisper', tts: 'edge_tts', vision: 'gemini', ocr: 'tesseract' }

const SETTINGS_COLUMN = {
  llm: ['active_llm_provider'],
  asr: ['active_subtitle_provider'],
  tts: ['active_voice_provider', 'voice_provider'],
  vision: [],
  ocr: [],
}

async function resolveApiKey(userId, providerId) {
  const rows = await query(
    `SELECT encrypted_key FROM api_keys WHERE user_id = ? AND provider = ? AND is_active = 1 ORDER BY created_date DESC`,
    [userId, providerId]
  )
  for (const row of rows) {
    if (!row.encrypted_key) continue
    try {
      const key = decrypt(row.encrypted_key)
      if (key) return key
    } catch (_) {}
  }
  for (const envName of ENV_KEYS[providerId] || []) {
    if (process.env[envName]) return process.env[envName]
  }
  return null
}

async function getUserChoice(userId, type) {
  const settings = await queryOne('SELECT * FROM settings WHERE user_id = ?', [userId])
  for (const column of SETTINGS_COLUMN[type]) {
    const value = settings?.[column]
    if (value && REGISTRY[type][value] !== undefined) return value
  }
  return DEFAULTS[type]
}

export async function getProvider(userId, type, { id } = {}) {
  const providerId = id || (await getUserChoice(userId, type))
  const factory = REGISTRY[type]?.[providerId]
  if (factory === undefined) {
    throw new ProviderError(
      `Không có nhà cung cấp '${type}' với id '${providerId}'. Các lựa chọn hợp lệ: ${Object.keys(REGISTRY[type] || {}).join(', ')}`
    )
  }
  if (factory === null) {
    throw new ProviderError(
      `${PROVIDER_LABELS[providerId] || providerId} chưa được hỗ trợ trên máy chủ này. Hãy chọn nhà cung cấp khác trong Cài đặt.`
    )
  }
  if (KEYLESS.has(providerId)) {
    return { id: providerId, provider: factory(null) }
  }
  const apiKey = await resolveApiKey(userId, providerId)
  if (!apiKey) {
    // OCR: nếu provider yêu cầu key mà không có → tự động dùng Tesseract local
    // (miễn phí, không key) thay vì báo lỗi, để pipeline vẫn chạy được.
    if (type === 'ocr' && REGISTRY.ocr?.tesseract) {
      console.warn(`[provider] ocr '${providerId}' thiếu API key — dùng Tesseract local`)
      return { id: 'tesseract', provider: REGISTRY.ocr.tesseract(null) }
    }
    throw new ProviderError(
      `Chưa cấu hình API key cho ${PROVIDER_LABELS[providerId] || providerId}. Thêm key tại trang API Keys (provider: ${providerId}) hoặc đặt biến môi trường ${(ENV_KEYS[providerId] || []).join(' / ')}`
    )
  }
  return { id: providerId, provider: factory(apiKey) }
}

export default { getProvider, PROVIDER_LABELS, ProviderError }
