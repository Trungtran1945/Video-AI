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

// TransFlow-inspired machine-readable codes (provider_errors.py).
// RATE_LIMITED (retryable, short cooldown) !== QUOTA_EXCEEDED (non-retry
// same key, long cooldown + failover). `kind` stays backward-compatible so
// existing callers checking TRANSIENT/PERMANENT keep working; `code` carries
// the precise distinction and `retryable` is authoritative.
export const ERROR_CODES = {
  PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  PROVIDER_QUOTA_EXCEEDED: 'PROVIDER_QUOTA_EXCEEDED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_NETWORK_ERROR: 'PROVIDER_NETWORK_ERROR',
  PROVIDER_AUTH_FAILED: 'PROVIDER_AUTH_FAILED',
  PROVIDER_PERMISSION_DENIED: 'PROVIDER_PERMISSION_DENIED',
  PROVIDER_MODEL_NOT_FOUND: 'PROVIDER_MODEL_NOT_FOUND',
  PROVIDER_INVALID_REQUEST: 'PROVIDER_INVALID_REQUEST',
  PROVIDER_RESPONSE_MALFORMED: 'PROVIDER_RESPONSE_MALFORMED',
}

// Cooldown per code (ms), ported from TransFlow ProviderHealthServiceImpl.
// Configurable via env PROVIDER_COOLDOWN_*_MS; defaults below.
export const DEFAULT_COOLDOWNS_MS = {
  PROVIDER_RATE_LIMITED: 60_000,
  PROVIDER_QUOTA_EXCEEDED: 30 * 60_000,
  PROVIDER_UNAVAILABLE: 2 * 60_000,
  PROVIDER_TIMEOUT: 2 * 60_000,
  PROVIDER_NETWORK_ERROR: 2 * 60_000,
  PROVIDER_AUTH_FAILED: 30 * 60_000,
  PROVIDER_PERMISSION_DENIED: 30 * 60_000,
  PROVIDER_MODEL_NOT_FOUND: 30 * 60_000,
}

export function cooldownMsForCode(code) {
  const envMap = {
    PROVIDER_RATE_LIMITED: 'PROVIDER_COOLDOWN_RATE_LIMIT_MS',
    PROVIDER_QUOTA_EXCEEDED: 'PROVIDER_COOLDOWN_QUOTA_MS',
    PROVIDER_UNAVAILABLE: 'PROVIDER_COOLDOWN_UNAVAILABLE_MS',
    PROVIDER_TIMEOUT: 'PROVIDER_COOLDOWN_TIMEOUT_MS',
    PROVIDER_NETWORK_ERROR: 'PROVIDER_COOLDOWN_NETWORK_MS',
  }
  const envName = envMap[code]
  if (envName) {
    const v = Number(process.env[envName])
    if (Number.isFinite(v) && v >= 0) return v
  }
  return DEFAULT_COOLDOWNS_MS[code] ?? 60_000
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
  const codeFromErr = typeof err?.code === 'string' ? err.code : null
  if (codeFromErr && Object.values(ERROR_CODES).includes(codeFromErr)) {
    return {
      kind: kindForCode(codeFromErr),
      code: codeFromErr,
      status,
      retryable: retryableForCode(codeFromErr),
      message,
    }
  }

  // Malformed payloads from an otherwise-reachable provider.
  if (err instanceof SyntaxError && /json|unexpected token/i.test(message)) {
    return { kind: ERROR_KINDS.INVALID_RESPONSE, code: ERROR_CODES.PROVIDER_RESPONSE_MALFORMED, status, retryable: false, message }
  }
  if (/empty (result|response|content)|invalid schema|malformed/i.test(lower)) {
    return { kind: ERROR_KINDS.INVALID_RESPONSE, code: ERROR_CODES.PROVIDER_RESPONSE_MALFORMED, status, retryable: false, message }
  }

  // Quota exhaustion MUST be detected before generic 429 handling.
  // 429 can be a temporary rate limit; quota keywords mean the key/plan is
  // depleted and retrying the same key cannot help.
  if (isQuotaMessage(lower)) {
    return { kind: ERROR_KINDS.TRANSIENT, code: ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, status: status ?? 429, retryable: false, message }
  }

  // Model not found (vendor text or 404 with model hint) — never blind-retry.
  if (/model not found|model_not_found|invalid model|model does not exist|unsupported model|model not supported/i.test(lower)) {
    return { kind: ERROR_KINDS.CONFIGURATION, code: ERROR_CODES.PROVIDER_MODEL_NOT_FOUND, status: status ?? 404, retryable: false, message }
  }

  // Configuration problems — retrying the same request cannot help.
  if (status === 404 || /not[_-]?found|missing .*url|invalid .*endpoint|apps script/i.test(lower)) {
    if (/http 404|status 404|not found/i.test(lower) || status === 404) {
      return { kind: ERROR_KINDS.CONFIGURATION, code: ERROR_CODES.PROVIDER_INVALID_REQUEST, status: status ?? 404, retryable: false, message }
    }
  }

  // Permanent auth failures.
  if (status === 401 || /invalid credentials|unauthorized|invalid api key|authentication failed/i.test(lower)) {
    return { kind: ERROR_KINDS.PERMANENT, code: ERROR_CODES.PROVIDER_AUTH_FAILED, status: status ?? 401, retryable: false, message }
  }
  if (status === 403 || /forbidden|permission denied|account suspended/i.test(lower)) {
    const isSuspended = /account suspended/i.test(lower)
    return {
      kind: ERROR_KINDS.PERMANENT,
      code: isSuspended ? ERROR_CODES.PROVIDER_PERMISSION_DENIED : ERROR_CODES.PROVIDER_PERMISSION_DENIED,
      status: status ?? 403,
      retryable: false,
      message,
    }
  }

  // Rate limited (temporary) — distinct from quota above.
  if (status === 429 || /too many requests|rate[ -_]?limit|throttling|please retry|resource has been exhausted|retry in\s+[\d.]+\s*s/i.test(lower)) {
    return { kind: ERROR_KINDS.TRANSIENT, code: ERROR_CODES.PROVIDER_RATE_LIMITED, status: status ?? 429, retryable: true, message }
  }

  // Timeout / network blips.
  if (/timeout|timed out|econnreset|econnrefused|enotfound|socket hang up|fetch failed|network|transport/i.test(lower) || status === 504) {
    const isTimeout = /timeout|timed out/i.test(lower) || status === 504
    return {
      kind: ERROR_KINDS.TRANSIENT,
      code: isTimeout ? ERROR_CODES.PROVIDER_TIMEOUT : ERROR_CODES.PROVIDER_NETWORK_ERROR,
      status,
      retryable: true,
      message,
    }
  }

  // Transient: overload / server errors.
  if (
    status === 503 || status === 500 || status === 502 ||
    /high demand|overloaded|unavailable|temporar|try again|internal error/i.test(lower)
  ) {
    return { kind: ERROR_KINDS.TRANSIENT, code: ERROR_CODES.PROVIDER_UNAVAILABLE, status, retryable: true, message }
  }

  // Unknown — do not retry by default; callers must decide explicitly.
  return { kind: ERROR_KINDS.INVALID_RESPONSE, code: ERROR_CODES.PROVIDER_INVALID_REQUEST, status, retryable: false, message }
}

function isQuotaMessage(lower) {
  return /quota exceeded|quota exhausted|allocation.?quota|insufficient.?quota|prepaid exhausted|balance insufficient|free tier|billing quota|daily limit|quota depleted|generate_content_free_tier|free_tier_requests|resource_exhausted.*quota|quota.*exhausted/i.test(lower)
}

function kindForCode(code) {
  switch (code) {
    case ERROR_CODES.PROVIDER_RATE_LIMITED:
    case ERROR_CODES.PROVIDER_TIMEOUT:
    case ERROR_CODES.PROVIDER_NETWORK_ERROR:
    case ERROR_CODES.PROVIDER_UNAVAILABLE:
      return ERROR_KINDS.TRANSIENT
    case ERROR_CODES.PROVIDER_AUTH_FAILED:
    case ERROR_CODES.PROVIDER_PERMISSION_DENIED:
      return ERROR_KINDS.PERMANENT
    case ERROR_CODES.PROVIDER_MODEL_NOT_FOUND:
    case ERROR_CODES.PROVIDER_INVALID_REQUEST:
      return ERROR_KINDS.CONFIGURATION
    case ERROR_CODES.PROVIDER_RESPONSE_MALFORMED:
      return ERROR_KINDS.INVALID_RESPONSE
    case ERROR_CODES.PROVIDER_QUOTA_EXCEEDED:
      return ERROR_KINDS.TRANSIENT
    default:
      return ERROR_KINDS.INVALID_RESPONSE
  }
}

function retryableForCode(code) {
  // Only temporary pressure is retryable on the SAME key.
  // Quota/auth/model/config never retry same key (failover instead).
  return code === ERROR_CODES.PROVIDER_RATE_LIMITED
    || code === ERROR_CODES.PROVIDER_TIMEOUT
    || code === ERROR_CODES.PROVIDER_NETWORK_ERROR
    || code === ERROR_CODES.PROVIDER_UNAVAILABLE
}

export function errorCodeOf(err) {
  try {
    return classifyProviderError(err).code
  } catch (_) {
    return ERROR_CODES.PROVIDER_INVALID_REQUEST
  }
}

export function isQuotaExceededError(err) {
  return classifyProviderError(err).code === ERROR_CODES.PROVIDER_QUOTA_EXCEEDED
}

export function isRateLimitedError(err) {
  return classifyProviderError(err).code === ERROR_CODES.PROVIDER_RATE_LIMITED
}

export function isRetryableProviderError(err) {
  return classifyProviderError(err).retryable === true
}

export default { ERROR_KINDS, ERROR_CODES, DEFAULT_COOLDOWNS_MS, cooldownMsForCode, classifyProviderError, isRetryableProviderError, retryDelayMs, errorCodeOf, isQuotaExceededError, isRateLimitedError }
