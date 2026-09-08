/**
 * Token Bucket + Sliding Window rate limiter per (userId, provider, apiKeyId).
 *
 * Token Bucket: allows small bursts up to bucket capacity; refill = requestsPerMinute / 60 per second.
 * Sliding Window: hard daily cap — throws RateLimitExhaustedError when requestsPerDay hit.
 *
 * docs/11 §2.2
 */

export class RateLimitExhaustedError extends Error {
  constructor(provider, resetAt) {
    super(`Rate limit exhausted for ${provider}. Resets at ${resetAt.toISOString()}`)
    this.name = 'RateLimitExhaustedError'
    this.provider = provider
    this.resetAt = resetAt
  }
}

/**
 * @typedef {Object} RateLimiterOptions
 * @property {number} requestsPerMinute
 * @property {number} [requestsPerDay]
 * @property {number} concurrency
 */

/**
 * In-memory rate limiter (per process).
 * For multi-process / multi-server, use Redis-based implementation (future).
 */
export class RateLimiter {
  #rpm
  #rpd
  #concurrency
  #bucket
  #bucketLastRefill
  #minuteWindow // sliding window: counts per-minute buckets
  #dayCount
  #dayResetAt
  #active

  /**
   * @param {RateLimiterOptions} opts
   */
  constructor({ requestsPerMinute = 10, requestsPerDay, concurrency = 1 }) {
    this.#rpm = requestsPerMinute
    this.#rpd = requestsPerDay || null
    this.#concurrency = concurrency
    this.#bucket = requestsPerMinute
    this.#bucketLastRefill = Date.now()
    this.#minuteWindow = []
    this.#dayCount = 0
    this.#dayResetAt = this.#calcDayReset()
    this.#active = 0
  }

  #calcDayReset() {
    const now = new Date()
    const tomorrow = new Date(now)
    tomorrow.setUTCHours(24, 0, 0, 0)
    return tomorrow
  }

  #refillBucket() {
    const now = Date.now()
    const elapsed = (now - this.#bucketLastRefill) / 1000
    const refillRate = this.#rpm / 60 // tokens per second
    this.#bucket = Math.min(this.#rpm, this.#bucket + elapsed * refillRate)
    this.#bucketLastRefill = now
  }

  #purgeMinuteWindow() {
    const now = Date.now()
    const oneMinAgo = now - 60000
    this.#minuteWindow = this.#minuteWindow.filter(t => t > oneMinAgo)
  }

  #purgeDayCount() {
    if (new Date() >= this.#dayResetAt) {
      this.#dayCount = 0
      this.#dayResetAt = this.#calcDayReset()
    }
  }

  /**
   * Wait until a slot is available. Throws RateLimitExhaustedError if daily limit hit.
   */
  async acquire() {
    this.#purgeDayCount()

    // Check daily limit first
    if (this.#rpd && this.#dayCount >= this.#rpd) {
      throw new RateLimitExhaustedError('(daily)', this.#dayResetAt)
    }

    // Check concurrency
    while (this.#active >= this.#concurrency) {
      await new Promise(r => setTimeout(r, 200))
    }

    // Token bucket: wait until token available
    this.#refillBucket()
    while (this.#bucket < 1) {
      const waitMs = Math.ceil(((1 - this.#bucket) / (this.#rpm / 60)) * 1000) + 50
      await new Promise(r => setTimeout(r, waitMs))
      this.#refillBucket()
    }

    // Sliding window: wait if too many requests in last minute
    this.#purgeMinuteWindow()
    while (this.#minuteWindow.length >= this.#rpm) {
      const oldestInWindow = this.#minuteWindow[0]
      const waitMs = oldestInWindow + 60000 - Date.now() + 50
      if (waitMs > 0) await new Promise(r => setTimeout(r, Math.min(waitMs, 1000)))
      this.#purgeMinuteWindow()
    }

    // Consume
    this.#bucket -= 1
    this.#minuteWindow.push(Date.now())
    this.#dayCount += 1
    this.#active += 1
  }

  /**
   * Release concurrency slot after provider call completes.
   */
  release() {
    this.#active = Math.max(0, this.#active - 1)
  }

  /**
   * Get current usage snapshot.
   * @returns {{ usedThisMinute: number, usedToday: number, remainingToday: number|null }}
   */
  getUsageSnapshot() {
    this.#purgeMinuteWindow()
    this.#purgeDayCount()
    return {
      usedThisMinute: this.#minuteWindow.length,
      usedToday: this.#dayCount,
      remainingToday: this.#rpd ? this.#rpd - this.#dayCount : null,
    }
  }

  /**
   * Manually mark a rate-limited response (for cooldown on 429).
   */
  markRateLimited() {
    this.#bucket = 0
    this.#bucketLastRefill = Date.now() + 10000 // freeze bucket for 10s
  }
}

// ── Global registry: one RateLimiter per (userId, provider, apiKeyId) ──

const registry = new Map()

/**
 * Get or create a RateLimiter for a given key.
 * @param {string} userId
 * @param {string} provider
 * @param {string} [apiKeyId]
 * @param {RateLimiterOptions} opts
 * @returns {RateLimiter}
 */
export function getRateLimiter(userId, provider, apiKeyId, opts) {
  const key = `${userId}:${provider}:${apiKeyId || 'default'}`
  if (!registry.has(key)) {
    registry.set(key, new RateLimiter(opts))
  }
  return registry.get(key)
}

export default { RateLimiter, RateLimitExhaustedError, getRateLimiter }
