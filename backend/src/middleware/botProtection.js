import { sendError } from '../lib/httpError.js'
import { getClientIp } from './rateLimiter.js'

let turnstileVerifierOverride = null

/**
 * Verifies Cloudflare Turnstile CAPTCHA token server-side.
 *
 * @param {string} token - The client response token from Turnstile widget
 * @param {string} [remoteIp] - The client IP address
 * @returns {Promise<{ success: boolean, code?: string, message?: string, bypassed?: boolean }>}
 */
export async function verifyTurnstileToken(token, remoteIp) {
  if (typeof turnstileVerifierOverride === 'function') {
    return turnstileVerifierOverride(token, remoteIp)
  }

  const secretKey = process.env.TURNSTILE_SECRET_KEY
  // If not configured, safely bypass verification (local development / testing / CI)
  if (!secretKey) {
    return { success: true, bypassed: true }
  }

  if (!token || typeof token !== 'string' || !token.trim()) {
    return {
      success: false,
      code: 'MISSING_CAPTCHA',
      message: 'Mã xác thực bot (Turnstile) bị thiếu hoặc không hợp lệ.',
    }
  }

  try {
    const formData = new URLSearchParams()
    formData.append('secret', secretKey)
    formData.append('response', token.trim())
    if (remoteIp && remoteIp !== 'unknown') {
      formData.append('remoteip', remoteIp)
    }

    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })

    if (!res.ok) {
      return {
        success: false,
        code: 'CAPTCHA_SERVICE_ERROR',
        message: 'Không thể kết nối đến dịch vụ xác thực bot.',
      }
    }

    const data = await res.json()
    if (data.success) {
      return { success: true, payload: data }
    }

    return {
      success: false,
      code: 'CAPTCHA_FAILED',
      message: 'Xác thực bot không thành công. Vui lòng thử lại.',
    }
  } catch (err) {
    console.error('[BotProtection] Turnstile verification exception:', err)
    // Fail-closed when turnstile secret is explicitly configured
    return {
      success: false,
      code: 'CAPTCHA_VERIFICATION_ERROR',
      message: 'Lỗi xác thực hệ thống bảo vệ bot.',
    }
  }
}

/**
 * Checks for known suspicious/scraper user agents on sensitive auth endpoints
 */
export function isSuspiciousUserAgent(userAgent) {
  if (!userAgent || typeof userAgent !== 'string') return false
  const ua = userAgent.toLowerCase()
  const scraperPatterns = [
    'curl/',
    'wget/',
    'python-requests',
    'python-urllib',
    'libwww-perl',
    'scrapy',
    'phantomjs',
    'go-http-client',
  ]
  return scraperPatterns.some((pattern) => ua.includes(pattern))
}

/**
 * Express middleware for Cloudflare Turnstile / Bot Verification
 */
export function botProtection(options = {}) {
  const {
    enforce = Boolean(process.env.TURNSTILE_SECRET_KEY || process.env.STRICT_BOT_PROTECTION === 'true'),
    action = 'auth',
  } = options

  return async function botProtectionMiddleware(req, res, next) {
    if (!enforce && !process.env.TURNSTILE_SECRET_KEY && process.env.STRICT_BOT_PROTECTION !== 'true') {
      return next()
    }

    const ip = getClientIp(req)
    const token =
      req.headers['cf-turnstile-response'] ||
      req.headers['x-turnstile-token'] ||
      req.body?.turnstileToken ||
      req.body?.['cf-turnstile-response']

    const result = await verifyTurnstileToken(token, ip)
    if (!result.success) {
      return sendError(res, 403, result.code || 'BOT_DETECTED', result.message || 'Xác thực bảo vệ bot không thành công.', { action })
    }

    next()
  }
}

export function __setTurnstileVerifierForTest(fn) {
  turnstileVerifierOverride = fn
}

export function __resetTurnstileVerifierForTest() {
  turnstileVerifierOverride = null
}

export default {
  verifyTurnstileToken,
  isSuspiciousUserAgent,
  botProtection,
  __setTurnstileVerifierForTest,
  __resetTurnstileVerifierForTest,
}
