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

export function classifyAggregateFailover(attempted) {
  const codes = (attempted || []).map((a) => a?.code).filter(Boolean)
  if (!codes.length) return 'MIXED'
  const kinds = new Set()
  for (const a of attempted) {
    if (a?.code === 'PROVIDER_QUOTA_EXCEEDED') kinds.add('QUOTA')
    else if (a?.code === 'PROVIDER_AUTH_FAILED') kinds.add('AUTH')
    else if (a?.code === 'PROVIDER_PERMISSION_DENIED') kinds.add('PERMISSION')
    else if (a?.code === 'PROVIDER_MODEL_NOT_FOUND' || a?.code === 'PROVIDER_INVALID_REQUEST' || a?.code === 'PROVIDER_RESPONSE_MALFORMED') kinds.add('CONFIGURATION')
    else if (a?.retryable === true) kinds.add('TRANSIENT')
    else kinds.add('MIXED')
  }
  if (kinds.size === 1) {
    const only = [...kinds][0]
    if (only === 'TRANSIENT') return 'ALL_TRANSIENT'
    if (only === 'QUOTA') return 'ALL_QUOTA'
    if (only === 'AUTH') return 'ALL_AUTH'
    if (only === 'PERMISSION') return 'ALL_PERMISSION'
    if (only === 'CONFIGURATION') return 'ALL_CONFIGURATION'
  }
  return 'MIXED'
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
  let attempt = 0
  // Prefer available first, but still try stale keys if nothing available
  // (a stale health flag must never block every job — TransFlow behavior).
  const ordered = [
    ...list.filter((c) => isProviderAvailable(c) && !isExcludedInScope(providerKeyOf(c))),
    ...list.filter((c) => !(isProviderAvailable(c) && !isExcludedInScope(providerKeyOf(c)))),
  ]
  // BE-F01: dedupe trước slice — normalize → providerKey → dedupe → health
  // ordering → maxAttempts. Slice-trước-dedupe có thể bỏ sót candidate duy nhất
  // còn khả dụng (vd A:key1,A:key1,B:key2 + maxAttempts=2 → phải thử A,B).
  const seen = new Set()
  const deduped = []
  for (const cand of ordered) {
    const key = providerKeyOf(cand)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(cand)
  }
  for (const cand of deduped.slice(0, Math.max(1, maxAttempts))) {
    const key = providerKeyOf(cand)
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
      errors.push({ provider: cand.id, apiKeyId: cand.apiKeyId || null, code: cls.code, kind: cls.kind, retryable: cls.retryable === true, attempt, message: String(err?.message || '').slice(0, 300) })
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
  // BE-F02: aggregate classification — retryable phản ánh tổng, không mù false.
  // all-transient → true (caller được retry/backoff); all-quota/auth/permission/
  // configuration → false; mixed → false + classification chi tiết cho UI.
  const aggregate = classifyAggregateFailover(errors)
  e.details = { attempted: errors, totalCandidates: list.length, aggregate }
  e.aggregate = aggregate
  e.retryable = aggregate === 'ALL_TRANSIENT'
  throw e
}

export default { withProviderFailover, isFailoverError }
