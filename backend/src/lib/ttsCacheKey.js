import crypto from 'node:crypto'

// Canonical TTS cache fingerprint — port of TransFlow tts_clip_key idea:
// same provider + voice/model + text + speed → same audio. Never includes
// outPath, tmp paths, api keys, or secrets.
function normalizeText(text) {
  return String(text || '').normalize('NFC').replace(/\s+/g, ' ').trim()
}

export function buildTtsCacheInput({ provider, voice, model, text, speed = 1 }) {
  const voiceNorm = String(voice ?? model ?? '').trim()
  const modelNorm = String(model ?? voice ?? '').trim() || 'unknown'
  const speedNum = Number(speed)
  const speedNorm = Number.isFinite(speedNum) ? String(Math.min(2, Math.max(0.5, speedNum))) : '1'
  const clean = normalizeText(text)
  if (!clean) throw new Error('[TTS cache] text is required for cache identity')
  return {
    v: 1,
    provider: String(provider || '').trim(),
    voice: voiceNorm,
    model: modelNorm,
    text: clean,
    speed: speedNorm,
  }
}

export function ttsClipKey(input) {
  const canonical = buildTtsCacheInput(input)
  const payload = JSON.stringify(canonical)
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 64)
}

export function isCanonicalTtsCacheInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  try {
    buildTtsCacheInput(input)
    return input?.v === 1
  } catch (_) {
    return false
  }
}

export default { buildTtsCacheInput, ttsClipKey, isCanonicalTtsCacheInput }
