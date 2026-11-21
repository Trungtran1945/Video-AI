/**
 * Security Headers Middleware (OWASP ASVS L2 & SEC-11)
 *
 * Implements comprehensive defense-in-depth HTTP security headers:
 * 1. Fingerprint elimination: disables X-Powered-By
 * 2. MIME sniffing defense: X-Content-Type-Options: nosniff
 * 3. Clickjacking defense: X-Frame-Options: SAMEORIGIN
 * 4. Referrer protection: Referrer-Policy: strict-origin-when-cross-origin
 * 5. Hardware capability restriction: Permissions-Policy
 * 6. Process isolation: Cross-Origin-Opener-Policy: same-origin-allow-popups
 * 7. Tiered CORP: same-origin for API endpoints, cross-origin for static media
 * 8. Tailored CSP: Content-Security-Policy accommodating Vite, Google Auth & Media Streaming
 * 9. Tiered Cache-Control: strict no-store on sensitive auth/keys/settings/users routes
 */

export const DEFAULT_CSP_DIRECTIVES = {
  'default-src': "'self'",
  'script-src': "'self' 'unsafe-inline' https://accounts.google.com",
  'style-src': "'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src': "'self' data: https://fonts.gstatic.com",
  'img-src': "'self' data: blob: https://lh3.googleusercontent.com",
  'media-src': "'self' blob: data:",
  'connect-src': "'self' data: blob: https://accounts.google.com https://oauth2.googleapis.com",
  'object-src': "'none'",
  'base-uri': "'self'",
  'form-action': "'self'",
  'frame-ancestors': "'self'",
}

export const SENSITIVE_PATH_PREFIXES = [
  '/api/v1/auth',
  '/api/v1/api-keys',
  '/api/v1/settings',
  '/api/v1/users',
  '/api/v1/admin',
]

/**
 * Build Content-Security-Policy header string from directives object.
 * @param {Record<string, string>} directives
 * @returns {string}
 */
export function buildCspHeader(directives = DEFAULT_CSP_DIRECTIVES) {
  return Object.entries(directives)
    .map(([key, val]) => `${key} ${val}`)
    .join('; ')
}

/**
 * Determines whether a given request path accesses sensitive credentials or user data.
 * @param {string} path
 * @returns {boolean}
 */
export function isSensitivePath(path = '') {
  if (typeof path !== 'string' || !path) return false
  const normalized = path.toLowerCase().split('?')[0]
  return SENSITIVE_PATH_PREFIXES.some(prefix => normalized.startsWith(prefix))
}

/**
 * Middleware factory for applying comprehensive security headers.
 * @param {object} [options]
 * @param {Record<string, string>} [options.cspDirectives]
 * @param {string} [options.csp]
 * @returns {import('express').RequestHandler}
 */
export function securityHeadersMiddleware(options = {}) {
  const csp = options.csp !== undefined
    ? options.csp
    : buildCspHeader(options.cspDirectives || DEFAULT_CSP_DIRECTIVES)

  return function securityHeaders(req, res, next) {
    // 1. Server fingerprint elimination
    res.removeHeader('X-Powered-By')

    // 2. Baseline ASVS L2 browser protection headers
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')

    // 3. Content-Security-Policy
    if (csp) {
      res.setHeader('Content-Security-Policy', csp)
    }

    // 4. Tiered Cross-Origin-Resource-Policy
    // Storage assets (/storage/*) are configured separately with 'cross-origin' and CORS *
    // All other endpoints default to 'same-origin'
    const fullPath = req.originalUrl || req.url || req.path || ''
    if (!fullPath.startsWith('/storage')) {
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    }

    // 5. Tiered Cache-Control for sensitive endpoints
    if (isSensitivePath(fullPath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
      res.setHeader('Surrogate-Control', 'no-store')
    }

    // 6. Strict-Transport-Security (HSTS - 1 year with subdomains and preload, SEC-12 & OWASP ASVS L2)
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https'
    const shouldAddHsts = isSecure || process.env.NODE_ENV === 'production' || process.env.FORCE_HTTPS === 'true' || options.hsts
    if (shouldAddHsts) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')
    }

    next()
  }
}

/**
 * Middleware to enforce HTTPS in production or when FORCE_HTTPS is enabled.
 * Redirects HTTP requests to HTTPS via 301 Permanent Redirect (OWASP ASVS L2 & SEC-12).
 * @param {object} [options]
 * @param {boolean} [options.forceHttps]
 * @returns {import('express').RequestHandler}
 */
export function httpsEnforcementMiddleware(options = {}) {
  return function httpsEnforce(req, res, next) {
    const isTest = (process.env.NODE_ENV === 'test')
    const forceHttps = options.forceHttps !== undefined
      ? options.forceHttps
      : (process.env.FORCE_HTTPS === 'true' || (process.env.NODE_ENV === 'production' && process.env.DISABLE_FORCE_HTTPS !== 'true'))

    // In test environment, bypass unless explicitly forced
    if (isTest && options.forceHttps !== true && process.env.FORCE_HTTPS !== 'true') {
      return next()
    }

    if (!forceHttps) {
      return next()
    }

    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https'
    if (!isSecure) {
      const host = req.headers.host || 'localhost'
      const targetUrl = `https://${host}${req.url}`
      return res.redirect(301, targetUrl)
    }

    next()
  }
}

/**
 * Route-level middleware to enforce strict no-cache on sensitive responses.
 * @type {import('express').RequestHandler}
 */
export function sensitiveNoCache(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  res.setHeader('Surrogate-Control', 'no-store')
  next()
}
