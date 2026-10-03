import { classifyProviderError, cooldownMsForCode, ERROR_CODES } from './providerErrors.js'
import { isExcludedInScope, scopeKey } from './providerScope.js'

// Minimal port of TransFlow ProviderHealthServiceImpl cooldowns.
// In-memory Map (per process) + fail-open. Redis optional: if REDIS is
// available callers may mirror these keys, but core pipeline never requires it.
const cooldownUntil = new Map() // providerKey -> epoch ms
const downUntil = new Map() // providerKey -> epoch ms (AUTH/PERMISSION/MODEL)

export function providerKeyOf({ provider, apiKeyId, id } = {}) {
  const p = (typeof provider === 'object' && provider !== null ? (provider.id || id) : provider) || id || ''
  return `${String(p)}:${String(apiKeyId || 'env')}`
}

function nowMs() {
  return Date.now()
}

export function reportProviderFailure({ provider, apiKeyId, errorCode }, opts = {}) {
  const err = opts.error || null
  const code = errorCode || (err ? classifyProviderError(err).code : ERROR_CODES.PROVIDER_UNAVAILABLE)
  const key = providerKeyOf({ provider, apiKeyId })
  const explicitTtl = Number.isFinite(Number(opts.cooldownMs)) ? Number(opts.cooldownMs) : null
  const ttl = explicitTtl ?? cooldownMsForCode(code)
  cooldownUntil.set(key, nowMs() + Math.max(0, ttl))
  if (
    code === ERROR_CODES.PROVIDER_AUTH_FAILED
    || code === ERROR_CODES.PROVIDER_PERMISSION_DENIED
    || code === ERROR_CODES.PROVIDER_MODEL_NOT_FOUND
  ) {
    downUntil.set(key, nowMs() + Math.max(ttl, 30 * 60_000))
  }
  // Structured observability (never logs keys/secrets).
  try {
    console.warn(
      `[AI_PROVIDER_FAILOVER] capability=${opts.capability || '-'} failedProvider=${provider} ` +
      `errorCode=${code} cooldownUntil=${new Date(cooldownUntil.get(key)).toISOString()} ` +
      `scope=${scopeKey() || '-'} attempt=${opts.attempt ?? '-'}`
    )
  } catch (_) {}
  return { providerKey: key, code, cooldownUntilMs: cooldownUntil.get(key) }
}

export function isProviderAvailable({ provider, apiKeyId }) {
  const key = providerKeyOf({ provider, apiKeyId })
  const now = nowMs()
  const cd = cooldownUntil.get(key)
  if (Number.isFinite(cd) && now < cd) return false
  const down = downUntil.get(key)
  if (Number.isFinite(down) && now < down) return false
  if (isExcludedInScope(key)) return false
  return true
}

export function cooldownUntilOf({ provider, apiKeyId }) {
  return cooldownUntil.get(providerKeyOf({ provider, apiKeyId })) || null
}

export function clearProviderHealthForTests() {
  cooldownUntil.clear()
  downUntil.clear()
}

export function availableCandidates(candidates) {
  return (candidates || []).filter((c) => isProviderAvailable(c))
}

export default {
  reportProviderFailure,
  isProviderAvailable,
  cooldownUntilOf,
  clearProviderHealthForTests,
  availableCandidates,
  providerKeyOf,
}
