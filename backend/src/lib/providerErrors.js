/**
 * providerErrors — classify external provider failures so callers can
 * decide: retry with backoff (TRANSIENT), abort (PERMANENT), surface a
 * configuration diagnostic (CONFIGURATION), or reject the payload
 * (INVALID_RESPONSE).
 *
 * Kinds:
 *   TRANSIENT      — 503 / 429 / 500 / timeout / network blips (retryable)
 *   PERMANENT      — 401 / 403 / invalid credentials (never retry)
 *   CONFIGURATION  — 404 endpoint / missing URL / bad config (never blind-retry)
 *   INVALID_RESPONSE — malformed JSON / empty result / bad schema
 */

export const ERROR_KINDS = {
  TRANSIENT: 'TRANSIENT',
  PERMANENT: 'PERMANENT',
  CONFIGURATION: 'CONFIGURATION',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
}

function statusOf(err) {
  if (err && Number.isInteger(err.status)) return err.status
  const m = String(err?.message || '').match(/HTTP\s+(\d{3})/i)
  return m ? Number(m[1]) : null
}

/** Extract provider-suggested wait (Retry-After header secs or "retry in Xs"). */
export function retryDelayMs(err, fallbackMs = 0) {
  const headerSec = Number(err?.retryAfter ?? err?.headers?.['retry-after'])
  if (Number.isFinite(headerSec) && headerSec > 0) return headerSec * 1000
  const m = String(err?.message || '').match(/retry in\s+([\d.]+)\s*s/i)
  if (m) return Number(m[1]) * 1000
  return fallbackMs
}

export function classifyProviderError(err) {
  const message = String(err?.message || '')
  const lower = message.toLowerCase()
  const status = statusOf(err)

  // Malformed payloads from an otherwise-reachable provider.
  if (err instanceof SyntaxError && /json|unexpected token/i.test(message)) {
    return { kind: ERROR_KINDS.INVALID_RESPONSE, status, retryable: false, message }
  }
  if (/empty (result|response|content)|invalid schema|malformed/i.test(lower)) {
    return { kind: ERROR_KINDS.INVALID_RESPONSE, status, retryable: false, message }
  }

  // Configuration problems — retrying the same request cannot help.
  if (status === 404 || /not[_-]?found|missing .*url|invalid .*endpoint|apps script/i.test(lower)) {
    if (/http 404|status 404|not found/i.test(lower) || status === 404) {
      return { kind: ERROR_KINDS.CONFIGURATION, status: status ?? 404, retryable: false, message }
    }
  }

  // Permanent auth failures.
  if (status === 401 || status === 403 || /invalid credentials|unauthorized|forbidden|invalid api key/i.test(lower)) {
    return { kind: ERROR_KINDS.PERMANENT, status, retryable: false, message }
  }

  // Transient: overload / throttling / server errors / network blips.
  if (
    status === 429 || status === 503 || status === 500 || status === 502 || status === 504 ||
    /high demand|overloaded|unavailable|temporar|try again|please retry|rate[ -_]?limit|quota|exhausted|timeout|timed out|econnreset|econnrefused|enotfound|socket hang up|fetch failed|network/i.test(lower)
  ) {
    return { kind: ERROR_KINDS.TRANSIENT, status, retryable: true, message }
  }

  // Unknown — do not retry by default; callers must decide explicitly.
  return { kind: ERROR_KINDS.INVALID_RESPONSE, status, retryable: false, message }
}

export function isRetryableProviderError(err) {
  return classifyProviderError(err).retryable === true
}

export default { ERROR_KINDS, classifyProviderError, isRetryableProviderError, retryDelayMs }
