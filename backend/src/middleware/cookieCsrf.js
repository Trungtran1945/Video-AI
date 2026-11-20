import { isOriginAllowed } from '../config.js'
import { sendError } from '../lib/httpError.js'

/**
 * Hardened same-origin CSRF guard for cookie-authenticated auth endpoints.
 *
 * Mitigates SEC-08 (missing Origin/Referer bypass) and SEC-09 (malformed Referer bypass).
 * - Detects cross-origin requests via Sec-Fetch-Site: cross-site even if Referer is stripped.
 * - Validates Origin against allowlist.
 * - Parses and validates Referer origin against allowlist, failing closed on unparseable Referer.
 * - In strict mode (STRICT_CSRF=true or options.strict=true), rejects requests lacking both Origin and Referer.
 */
export function cookieCsrf(optionsOrReq, maybeRes, maybeNext) {
  if (maybeRes && typeof maybeNext === 'function') {
    return handleCsrf({})(optionsOrReq, maybeRes, maybeNext)
  }
  return handleCsrf(optionsOrReq || {})
}

function handleCsrf(options = {}) {
  return (req, res, next) => {
    const hasCookie = (req.headers.cookie || '').includes('refresh_token=')
    if (!hasCookie) return next()

    const secFetchSite = req.headers['sec-fetch-site']
    if (secFetchSite === 'cross-site') {
      return sendError(res, 403, 'CSRF_ORIGIN_MISMATCH', 'Cross-origin request blocked')
    }

    const origin = req.headers.origin
    const referer = req.headers.referer

    const strict = options.strict ?? (process.env.STRICT_CSRF === 'true')

    if (!origin && !referer) {
      if (strict) {
        return sendError(
          res,
          403,
          'CSRF_CHECK_FAILED',
          'Origin or Referer header required for cookie-authenticated request'
        )
      }
      return next()
    }

    if (origin && !isOriginAllowed(origin)) {
      return sendError(res, 403, 'CSRF_ORIGIN_MISMATCH', 'Cross-origin request blocked')
    }

    if (referer) {
      let refOrigin = null
      try {
        refOrigin = new URL(referer).origin
      } catch (_) {
        // SEC-09: Fail closed on malformed / unparseable referer
        return sendError(res, 403, 'CSRF_ORIGIN_MISMATCH', 'Invalid or unparseable Referer header')
      }
      if (refOrigin && !isOriginAllowed(refOrigin)) {
        return sendError(res, 403, 'CSRF_ORIGIN_MISMATCH', 'Cross-origin request blocked')
      }
    }

    return next()
  }
}

export default cookieCsrf
