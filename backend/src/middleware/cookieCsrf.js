import { isOriginAllowed } from '../config.js'
import { sendError } from '../lib/httpError.js'

// Light same-origin CSRF guard for cookie-authenticated auth endpoints.
// Same-origin is enforced at the edge via nginx :80 + Vite proxy (/api ->
// localhost:3001); this middleware is a second layer that rejects an
// explicit cross-origin Origin/Referer when the refresh cookie is present.
// Bearer-only project APIs are untouched (no cookie -> next()).
export function cookieCsrf(req, res, next) {
  const hasCookie = (req.headers.cookie || '').includes('refresh_token=')
  if (!hasCookie) return next()
  const origin = req.headers.origin
  const referer = req.headers.referer
  if (!origin && !referer) return next()
  let cand = origin || null
  if (!cand && referer) {
    try {
      cand = new URL(referer).origin
    } catch (_) {
      return next()
    }
  }
  if (cand && !isOriginAllowed(cand)) {
    return sendError(res, 403, 'CSRF_ORIGIN_MISMATCH', 'Cross-origin request blocked')
  }
  return next()
}

export default cookieCsrf
