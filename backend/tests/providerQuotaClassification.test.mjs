// Provider error classification: RATE_LIMITED !== QUOTA_EXCEEDED (+ 8 codes).
// Regression: quota must NOT be treated as generic transient same-key retry.
import { classifyProviderError, ERROR_CODES } from '../src/lib/providerErrors.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }
const errWith = (message, status) => Object.assign(new Error(message), status ? { status } : {})

{
  const e = classifyProviderError(errWith('Too many requests, retry in 2s', 429))
  assert(e.code === ERROR_CODES.PROVIDER_RATE_LIMITED, '429 rate text → RATE_LIMITED code')
  assert(e.retryable === true, 'RATE_LIMITED retryable=true')
}

{
  const e = classifyProviderError(errWith('Quota exceeded for quota metric generate_content_free_tier_requests', 429))
  assert(e.code === ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, '429 quota text → QUOTA_EXCEEDED code')
  assert(e.retryable === false, 'QUOTA_EXCEEDED retryable=false (no blind same-key retry)')
}

{
  const e = classifyProviderError(errWith('Free tier exhausted, billing quota depleted', 429))
  assert(e.code === ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, 'free-tier/billing text → QUOTA_EXCEEDED')
}

{
  const e = classifyProviderError(errWith('Gemini HTTP 503', 503))
  assert(e.code === ERROR_CODES.PROVIDER_UNAVAILABLE && e.retryable === true, '503 → UNAVAILABLE retryable')
}

{
  const e = classifyProviderError(errWith('fetch failed: timeout', null))
  assert(e.code === ERROR_CODES.PROVIDER_TIMEOUT && e.retryable === true, 'timeout → TIMEOUT retryable')
}

{
  const e = classifyProviderError(errWith('socket hang up', null))
  assert(e.code === ERROR_CODES.PROVIDER_NETWORK_ERROR && e.retryable === true, 'network → NETWORK retryable')
}

{
  const e = classifyProviderError(errWith('API key not valid', 401))
  assert(e.code === ERROR_CODES.PROVIDER_AUTH_FAILED && e.retryable === false, '401 → AUTH_FAILED non-retryable')
}

{
  const e = classifyProviderError(errWith('forbidden', 403))
  assert(e.code === ERROR_CODES.PROVIDER_PERMISSION_DENIED && e.retryable === false, '403 → PERMISSION_DENIED non-retryable')
}

{
  const e = classifyProviderError(errWith('Model not found: whisper-9', 404))
  assert(e.code === ERROR_CODES.PROVIDER_MODEL_NOT_FOUND && e.retryable === false, 'model-not-found → MODEL_NOT_FOUND non-retryable')
}

// Regression: QUOTA must not equal generic transient handling.
{
  const quota = classifyProviderError(errWith('quota exhausted', 429))
  const rate = classifyProviderError(errWith('rate limit, retry in 1s', 429))
  assert(quota.code !== rate.code, 'QUOTA code differs from RATE code')
  assert(quota.retryable === false && rate.retryable === true, 'QUOTA non-retry vs RATE retry')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
