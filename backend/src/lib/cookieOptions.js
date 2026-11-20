import { config } from '../config.js'

export const REFRESH_COOKIE = 'refresh_token'
export const REFRESH_COOKIE_PATH = '/api/v1/auth'
export const DEFAULT_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/**
 * Generates standardized, secure cookie options for refresh tokens.
 *
 * - httpOnly: true (prevents XSS access to cookie)
 * - secure: config.cookieSecure (true in production/HTTPS)
 * - sameSite: 'lax' (or 'strict' when configured via COOKIE_SAMESITE)
 * - path: '/api/v1/auth' (cookie only sent to auth endpoints)
 * - maxAge: 7 days
 *
 * @param {Object} [overrides={}]
 * @returns {Object} Express cookie options
 */
export function getRefreshCookieOptions(overrides = {}) {
  const sameSite = overrides.sameSite || process.env.COOKIE_SAMESITE || 'lax'
  const secure = overrides.secure !== undefined ? overrides.secure : config.cookieSecure

  return {
    httpOnly: true,
    secure,
    sameSite,
    path: REFRESH_COOKIE_PATH,
    maxAge: DEFAULT_COOKIE_MAX_AGE_MS,
    ...overrides,
  }
}

/**
 * Returns options for clearing the refresh cookie.
 * Matches path, httpOnly, secure, and sameSite of the set cookie.
 */
export function getClearRefreshCookieOptions(overrides = {}) {
  const opts = getRefreshCookieOptions(overrides)
  delete opts.maxAge
  return opts
}

export default {
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  DEFAULT_COOKIE_MAX_AGE_MS,
  getRefreshCookieOptions,
  getClearRefreshCookieOptions,
}
