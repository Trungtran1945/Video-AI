import { sendError } from '../lib/httpError.js'
import { connection, isConnectionReady } from '../queue/connection.js'

// In-memory sliding window stores (default fallback and fast local cache)
const inMemoryStores = new Map()

/**
 * Safely extracts client IP address, supporting X-Forwarded-For header when behind reverse proxy
 */
export function getClientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for']
  if (forwarded) {
    const first = String(forwarded).split(',')[0].trim()
    if (first) return first
  }
  return req?.ip || req?.socket?.remoteAddress || 'unknown'
}

/**
 * Normalizes keys (trims, converts email or IP to lowercase to prevent casing bypass)
 */
export function normalizeRateLimitKey(key) {
  if (typeof key !== 'string') return String(key || 'unknown')
  return key.trim().toLowerCase()
}

/**
 * Gets or creates an in-memory Map store for a given namespace prefix
 */
function getMemoryStore(prefix = 'default') {
  if (prefix instanceof Map) return prefix
  const p = String(prefix)
  if (!inMemoryStores.has(p)) {
    inMemoryStores.set(p, new Map())
  }
  return inMemoryStores.get(p)
}

/**
 * Sliding window hit evaluator in memory.
 * Returns 0 if allowed, or retryAfterSec > 0 if limit exceeded.
 */
function memoryHitRateLimit(store, key, limit, windowMs, now = Date.now()) {
  const normKey = normalizeRateLimitKey(key)
  const hits = (store.get(normKey) || []).filter((t) => now - t < windowMs)
  hits.push(now)
  store.set(normKey, hits)

  if (hits.length > limit) {
    const oldest = hits[hits.length - 1 - limit]
    return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
  }
  return 0
}

/**
 * Sliding window check (inspection without consuming a hit).
 * Returns 0 if allowed, or retryAfterSec > 0 if limit reached.
 */
function memoryCheckRateLimit(store, key, limit, windowMs, now = Date.now()) {
  const normKey = normalizeRateLimitKey(key)
  const hits = (store.get(normKey) || []).filter((t) => now - t < windowMs)
  store.set(normKey, hits)

  if (hits.length >= limit) {
    const oldest = hits[0]
    return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
  }
  return 0
}

/**
 * Unconditionally record a hit in memory (e.g. for tracking failed login attempts).
 */
function memoryRecordHit(store, key, windowMs, now = Date.now()) {
  const normKey = normalizeRateLimitKey(key)
  const hits = (store.get(normKey) || []).filter((t) => now - t < windowMs)
  hits.push(now)
  store.set(normKey, hits)
}

/**
 * Clear a specific key in memory
 */
function memoryClearKey(store, key) {
  const normKey = normalizeRateLimitKey(key)
  store.delete(normKey)
}

/**
 * Dual-mode rate limit hit evaluator (Redis sliding window with memory fallback).
 *
 * @param {string|Map} storeOrPrefix - Map instance or string namespace prefix
 * @param {string} key - Identifier (IP, email, user_id)
 * @param {number} limit - Maximum allowed hits in window
 * @param {number} windowMs - Time window in milliseconds
 * @param {number} [now=Date.now()]
 * @returns {Promise<number>|number} retryAfterSec (0 = allowed, >0 = blocked)
 */
export async function hitRateLimitAsync(storeOrPrefix, key, limit, windowMs, now = Date.now()) {
  const normKey = normalizeRateLimitKey(key)

  // Use Redis if connection is ready and not an explicit Map instance
  if (!(storeOrPrefix instanceof Map) && isConnectionReady(connection)) {
    try {
      const prefix = String(storeOrPrefix || 'rl')
      const redisKey = `ratelimit:${prefix}:${normKey}`
      const clearBefore = now - windowMs

      const pipeline = connection.pipeline()
      pipeline.zremrangebyscore(redisKey, 0, clearBefore)
      pipeline.zcard(redisKey)
      pipeline.zrange(redisKey, 0, 0, 'WITHSCORES')
      pipeline.zadd(redisKey, now, `${now}:${Math.random().toString(36).slice(2, 8)}`)
      pipeline.expire(redisKey, Math.ceil(windowMs / 1000) + 10)

      const results = await pipeline.exec()
      if (results && results[1] && results[1][1] !== undefined) {
        const countBeforeAdd = results[1][1]
        if (countBeforeAdd >= limit) {
          // Exceeded limit: calculate retryAfterSec from the oldest entry in the window
          const oldestEntry = results[2] && results[2][1] && results[2][1][1]
          const oldestTime = oldestEntry ? parseInt(oldestEntry, 10) : clearBefore
          const retryAfterSec = Math.max(1, Math.ceil((oldestTime + windowMs - now) / 1000))
          return retryAfterSec
        }
        return 0
      }
    } catch (_) {
      // Fallback to in-memory on any Redis command error
    }
  }

  // Fallback / synchronous in-memory store
  const memStore = getMemoryStore(storeOrPrefix)
  return memoryHitRateLimit(memStore, normKey, limit, windowMs, now)
}

/**
 * Synchronous hit evaluator (maintains backward compatibility with synchronous callers)
 */
export function hitRateLimit(storeOrPrefix, key, limit, windowMs, now = Date.now()) {
  const memStore = getMemoryStore(storeOrPrefix)
  return memoryHitRateLimit(memStore, key, limit, windowMs, now)
}

/**
 * Check if limit is reached without recording a hit.
 */
export function checkRateLimit(storeOrPrefix, key, limit, windowMs, now = Date.now()) {
  const memStore = getMemoryStore(storeOrPrefix)
  return memoryCheckRateLimit(memStore, key, limit, windowMs, now)
}

/**
 * Record a rate limit hit unconditionally (e.g. record failed login attempt).
 */
export function recordRateLimitHit(storeOrPrefix, key, windowMs, now = Date.now()) {
  const memStore = getMemoryStore(storeOrPrefix)
  memoryRecordHit(memStore, key, windowMs, now)
}

/**
 * Reset rate limit for a specific key (e.g. on successful login).
 */
export function resetRateLimitKey(storeOrPrefix, key) {
  const memStore = getMemoryStore(storeOrPrefix)
  memoryClearKey(memStore, key)
  if (!(storeOrPrefix instanceof Map) && isConnectionReady(connection)) {
    try {
      const prefix = String(storeOrPrefix || 'rl')
      connection.del(`ratelimit:${prefix}:${normalizeRateLimitKey(key)}`).catch(() => {})
    } catch (_) {}
  }
}

/**
 * Resets all rate limit stores for tests
 */
export function resetAllRateLimits() {
  for (const store of inMemoryStores.values()) {
    store.clear()
  }
  inMemoryStores.clear()
}

/**
 * Express middleware factory for Rate Limiting.
 *
 * @param {object} options
 * @param {number} [options.windowMs=60000] - Window duration in ms
 * @param {number} [options.limit=60] - Max requests per window
 * @param {function} [options.keyGenerator] - Custom key extractor from req
 * @param {function} [options.skip] - Condition to skip rate limiting
 * @param {string} [options.message] - 429 error message
 * @param {string} [options.code='RATE_LIMITED'] - Error code
 * @param {string} [options.prefix='rl'] - Redis/memory namespace prefix
 * @param {boolean} [options.standardHeaders=true] - Send X-RateLimit headers
 * @returns {import('express').RequestHandler}
 */
export function createRateLimiter(options = {}) {
  const {
    windowMs = 60 * 1000,
    limit = 60,
    keyGenerator = (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown',
    skip = () => false,
    message = 'Quá nhiều yêu cầu. Vui lòng thử lại sau.',
    code = 'RATE_LIMITED',
    prefix = 'rl',
    standardHeaders = true,
  } = options

  return async function rateLimiterMiddleware(req, res, next) {
    try {
      if (typeof skip === 'function' && skip(req)) {
        return next()
      }

      const key = keyGenerator(req)
      const now = Date.now()
      const waitSec = await hitRateLimitAsync(prefix, key, limit, windowMs, now)

      if (waitSec > 0) {
        res.setHeader('Retry-After', String(waitSec))
        if (standardHeaders) {
          res.setHeader('X-RateLimit-Limit', String(limit))
          res.setHeader('X-RateLimit-Remaining', '0')
          res.setHeader('X-RateLimit-Reset', String(Math.ceil((now + waitSec * 1000) / 1000)))
        }
        return sendError(res, 429, code, message, { retryAfterSec: waitSec })
      }

      if (standardHeaders) {
        res.setHeader('X-RateLimit-Limit', String(limit))
        res.setHeader('X-RateLimit-Reset', String(Math.ceil((now + windowMs) / 1000)))
      }

      next()
    } catch (err) {
      // Rate limiter fails open to preserve service availability on unexpected internal faults
      console.error('[RateLimiter] Error:', err)
      next()
    }
  }
}

// --- Pre-configured Tiered Rate Limiters ---

/** Global API rate limiter: 300 requests / 1 minute per IP */
export const globalApiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  limit: 300,
  prefix: 'global_api',
  message: 'Quá nhiều yêu cầu từ địa chỉ IP này. Vui lòng thử lại sau ít phút.',
  skip: (req) => req.path === '/health' || req.path === '/ready',
})

/** Upload endpoints rate limiter: 60 requests / 1 minute per IP */
export const uploadRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  limit: 60,
  prefix: 'upload',
  message: 'Quá nhiều yêu cầu tải lên từ địa chỉ IP của bạn. Vui lòng thử lại sau.',
})

/** Register rate limiter: 10 requests / 15 minutes per IP */
export const registerRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  prefix: 'register_ip',
  message: 'Quá nhiều yêu cầu đăng ký từ địa chỉ IP này. Vui lòng thử lại sau.',
})

/** Google OAuth rate limiter: 10 requests / 15 minutes per IP */
export const googleRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  prefix: 'google_ip',
  message: 'Quá nhiều yêu cầu đăng nhập Google từ IP này. Vui lòng thử lại sau.',
})

/** Forgot password IP rate limiter: 5 requests / 10 minutes per IP */
export const forgotPasswordIpLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  prefix: 'forgot_ip',
  message: 'Quá nhiều yêu cầu đặt lại mật khẩu từ IP này, vui lòng thử lại sau.',
})

export default {
  getClientIp,
  normalizeRateLimitKey,
  hitRateLimit,
  hitRateLimitAsync,
  checkRateLimit,
  recordRateLimitHit,
  resetRateLimitKey,
  resetAllRateLimits,
  createRateLimiter,
  globalApiRateLimiter,
  uploadRateLimiter,
  registerRateLimiter,
  googleRateLimiter,
  forgotPasswordIpLimiter,
}
