import { classifyProviderError, ERROR_CODES } from './providerErrors.js'
import { recordProviderResolution, excludeProviderInScope, isExcludedInScope } from './providerScope.js'
import { reportProviderFailure, isProviderAvailable } from './providerHealth.js'
import { providerKeyOf } from './providerHealth.js'

// Minimal failover: try candidates in order, cooldown/exclude failures,
// continue on next provider. Returns { result, provider } or throws
// NO_PROVIDER_AVAILABLE with structured detail (no secrets).
const FAILOVER_CODES = new Set([
  ERROR_CODES.PROVIDER_RATE_LIMITED,
  ERROR_CODES.PROVIDER_QUOTA_EXCEEDED,
  ERROR_CODES.PROVIDER_UNAVAILABLE,
  ERROR_CODES.PROVIDER_TIMEOUT,
  ERROR_CODES.PROVIDER_NETWORK_ERROR,
  ERROR_CODES.PROVIDER_AUTH_FAILED,
  ERROR_CODES.PROVIDER_PERMISSION_DENIED,
  ERROR_CODES.PROVIDER_MODEL_NOT_FOUND,
])

export function isFailoverError(err) {
  try {
    return FAILOVER_CODES.has(classifyProviderError(err).code)
  } catch (_) {
    return false
  }
}

export async function withProviderFailover({ capability = '', candidates = [], maxAttempts = 4, onAttempt }, fn) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : []
  if (!list.length) {
    const e = new Error(`NO_PROVIDER_AVAILABLE: không có provider cho ${capability || 'capability'}`)
    e.code = 'NO_PROVIDER_AVAILABLE'
    e.capability = capability
    throw e
  }
  const errors = []
  const tried = new Set()
  let attempt = 0
  // Prefer available first, but still try stale keys if nothing available
  // (a stale health flag must never block every job — TransFlow behavior).
  const ordered = [
    ...list.filter((c) => isProviderAvailable(c) && !isExcludedInScope(providerKeyOf(c))),
    ...list.filter((c) => !(isProviderAvailable(c) && !isExcludedInScope(providerKeyOf(c)))),
  ]
  for (const cand of ordered.slice(0, Math.max(1, maxAttempts))) {
    const key = providerKeyOf(cand)
    if (tried.has(key)) continue
    tried.add(key)
    attempt++
    recordProviderResolution(capability, key)
    if (typeof onAttempt === 'function') {
      try { onAttempt({ attempt, provider: cand.id, apiKeyId: cand.apiKeyId }) } catch (_) {}
    }
    try {
      const result = await fn(cand, { attempt })
      return { result, provider: cand, attempt }
    } catch (err) {
      const cls = classifyProviderError(err)
      errors.push({ provider: cand.id, code: cls.code, message: String(err?.message || '').slice(0, 300) })
      if (!isFailoverError(err)) throw err
      reportProviderFailure(
        { provider: cand.id, apiKeyId: cand.apiKeyId, errorCode: cls.code },
        { capability, attempt, error: err }
      )
      excludeProviderInScope(key)
      // Quota/auth/model: never retry same key (already excluded); try next.
      // Rate/timeout/network: also try next provider first (faster than backoff).
      continue
    }
  }
  const first = errors[0]
  const e = new Error(
    `NO_PROVIDER_AVAILABLE: tất cả provider cho ${capability || 'capability'} đều thất bại` +
    (first ? ` (vd ${first.provider}: ${first.code})` : '')
  )
  e.code = 'NO_PROVIDER_AVAILABLE'
  e.capability = capability
  e.errorCode = first?.code || null
  e.details = { attempted: errors, totalCandidates: list.length }
  e.retryable = false
  throw e
}

export default { withProviderFailover, isFailoverError }
