/**
 * Canonical ASR cache input — single source of truth for ASR cache identity.
 *
 * Same audio + same effective ASR semantics → hit.
 * Any semantic difference → miss (including legacy rows missing metadata).
 *
 * Contains (all normalized):
 *   - audioContentHash (SHA-256 of audio bytes, streaming — never a tmp path)
 *   - sourceLanguage (normalized ISO-639-1 or 'auto')
 *   - effectiveModel
 *   - temperature (number)
 *   - initialPrompt (trimmed, sliced to provider limit)
 *   - responseFormat (e.g. 'verbose_json')
 *   - endpoint (normalized base URL identity when it affects semantics)
 *
 * Never contains: apiKey, Authorization, password, secret, token,
 * temporary file paths, absolute paths, or raw audio bytes.
 * The builder allow-lists exactly these fields, so no separate sanitizer
 * is needed on the hashing path (dead helper removed).
 */

function normalizeLanguage(value) {
  const raw = String(value ?? 'auto').trim().toLowerCase()
  if (!raw || raw === 'auto' || raw === 'unknown' || raw === 'null' || raw === 'undefined') return 'auto'
  const base = raw.replace(/_/g, '-').split('-')[0]
  if (!/^[a-z]{2,3}$/.test(base)) return 'auto'
  return base
}

function normalizeEndpoint(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  return raw.replace(/\/+$/, '')
}

/**
 * Build canonical ASR cache input. Throws when audioContentHash is missing
 * (caller must hash audio bytes first — path alone is never cacheable).
 */
export function buildAsrCacheInput({
  audioContentHash,
  fileHash,
  contentHash,
  sourceLanguage,
  language,
  effectiveModel,
  model,
  temperature,
  initialPrompt,
  prompt,
  responseFormat,
  endpoint,
} = {}) {
  const hash = String(audioContentHash ?? fileHash ?? contentHash ?? '').trim()
  if (!hash || !/^[a-f0-9]{16,128}$/i.test(hash)) {
    throw new Error('[ASR cache] audioContentHash (content SHA-256) is required for cache identity')
  }
  const effModel = String(effectiveModel ?? model ?? '').trim() || 'unknown'
  const tempNum = Number(temperature)
  const temp = Number.isFinite(tempNum) ? tempNum : 0
  const promptNorm = String(initialPrompt ?? prompt ?? '').trim().slice(0, 224)
  return {
    v: 2,
    audioContentHash: hash.toLowerCase(),
    sourceLanguage: normalizeLanguage(sourceLanguage ?? language),
    effectiveModel: effModel,
    temperature: temp,
    initialPrompt: promptNorm,
    responseFormat: String(responseFormat ?? 'verbose_json'),
    endpoint: normalizeEndpoint(endpoint),
  }
}

/**
 * True when an input object already carries canonical v2 ASR identity
 * (audio hash + effective model/temperature/prompt/format/endpoint).
 * Legacy rows ({fileHash, language} only) return false → cache miss.
 */
export function isCanonicalAsrCacheInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  try {
    buildAsrCacheInput(input)
    return input?.v === 2
  } catch (_) {
    return false
  }
}

export default { buildAsrCacheInput, isCanonicalAsrCacheInput }
