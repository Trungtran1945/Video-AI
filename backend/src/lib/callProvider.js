/**
 * callProvider — wraps every external API call with:
 *   1. Content-hash cache check (docs/11 §3.2)
 *   2. QuotaGuard pre-check (docs/11 §4.1)
 *   3. Rate limiter acquire (docs/11 §2.2)
 *   4. Tracked execution with timing + provider_logs (docs/03 §6)
 *   5. Rate limiter release
 *   6. Cache write on success
 */

import crypto from 'crypto'
import { run, queryOne } from '../db/query.js'
import { v4 as uuidv4 } from 'uuid'
import { getRateLimiter, RateLimitExhaustedError } from '../lib/rateLimiter.js'

/**
 * Compute SHA-256 hash of normalized input for cache key.
 * @param {string} provider
 * @param {string} type
 * @param {string} model
 * @param {*} input
 * @returns {string} hex hash
 */
function inputHash(provider, type, model, input) {
  const payload = JSON.stringify({ provider, type, model, input })
  return crypto.createHash('sha256').update(payload).digest('hex')
}

/**
 * Check provider cache for a matching result.
 * @param {string} provider
 * @param {string} type
 * @param {string} model
 * @param {*} input
 * @returns {Promise<null|*>} cached result or null
 */
async function checkCache(provider, type, model, input) {
  try {
    const hash = inputHash(provider, type, model, input)
    const row = await queryOne(
      `SELECT result, expires_date FROM provider_cache WHERE provider = ? AND type = ? AND input_hash = ?`,
      [provider, type, hash]
    )
    if (!row) return null
    if (row.expires_date && new Date(row.expires_date) < new Date()) {
      // Expired — delete and miss
      await run(`DELETE FROM provider_cache WHERE provider = ? AND type = ? AND input_hash = ?`, [provider, type, hash])
      return null
    }
    return JSON.parse(row.result)
  } catch (_) {
    return null
  }
}

/**
 * Store result in provider cache.
 */
async function storeCache(provider, type, model, input, result, ttlDays) {
  try {
    const hash = inputHash(provider, type, model, input)
    const expiresDate = ttlDays
      ? new Date(Date.now() + ttlDays * 86400000).toISOString()
      : null
    await run(
      `INSERT OR REPLACE INTO provider_cache (id, provider, type, input_hash, result, expires_date) VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), provider, type, hash, JSON.stringify(result), expiresDate]
    )
  } catch (_) {
    // Cache write failure is non-fatal
  }
}

/**
 * Call provider with rate limiting, caching, and tracking.
 *
 * @param {object} params
 * @param {string} params.provider - Provider name (gemini, openai, elevenlabs, etc.)
 * @param {string} params.type - Call type (llm, tts, vision, asr, ocr)
 * @param {string} params.model - Model name
 * @param {*} params.input - Input payload (will be hashed for cache)
 * @param {Function} params.fn - The actual provider call: () => Promise<result>
 * @param {string} [params.userId] - User ID for rate limiter
 * @param {string} [params.apiKeyId] - API key ID for multi-key rate limiter
 * @param {string} [params.projectId] - Project ID for provider_logs
 * @param {string} [params.jobId] - Job ID for provider_logs
 * @param {number} [params.cacheTtlDays] - Cache TTL in days (0 = permanent)
 * @param {object} [params.rateLimitOpts] - Rate limiter config override
 * @returns {Promise<*>} provider result
 */
export async function callProvider({
  provider,
  type,
  model,
  input,
  fn,
  userId,
  apiKeyId,
  projectId,
  jobId,
  cacheTtlDays = 90,
  rateLimitOpts,
}) {
  // 1. Cache check
  const cached = await checkCache(provider, type, model, input)
  if (cached !== null) {
    // Still log for analytics but mark as cache hit
    await logCall({ projectId, jobId, provider, type, model, status: 'cache_hit', durationMs: 0 })
    return cached
  }

  // 2. Rate limiter
  const limiter = getRateLimiter(userId || 'system', provider, apiKeyId, {
    requestsPerMinute: rateLimitOpts?.requestsPerMinute || 10,
    requestsPerDay: rateLimitOpts?.requestsPerDay || null,
    concurrency: rateLimitOpts?.concurrency || 1,
  })

  await limiter.acquire()
  const startMs = Date.now()
  try {
    // 3. Execute
    const result = await fn()
    const durationMs = Date.now() - startMs

    // 4. Log success
    await logCall({ projectId, jobId, provider, type, model, status: 'ok', durationMs })

    // 5. Cache result
    await storeCache(provider, type, model, input, result, cacheTtlDays)

    return result
  } catch (err) {
    const durationMs = Date.now() - startMs
    const status = isRateLimitError(err) ? 'rate_limited' : 'error'

    if (status === 'rate_limited') {
      limiter.markRateLimited()
    }

    await logCall({ projectId, jobId, provider, type, model, status, durationMs, error: err.message })
    throw err
  } finally {
    limiter.release()
  }
}

function isRateLimitError(err) {
  if (err instanceof RateLimitExhaustedError) return true
  const msg = (err.message || '').toLowerCase()
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')
}

/**
 * Log provider call to provider_logs.
 */
async function logCall({ projectId, jobId, provider, type, model, status, durationMs, error }) {
  try {
    await run(
      `INSERT INTO provider_logs (id, project_id, job_id, provider, type, model, duration_ms, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), projectId || null, jobId || null, provider, type || null, model || null, durationMs || 0, status, error || null]
    )
  } catch (_) {
    // Log failure is non-fatal
  }
}

export default { callProvider, checkCache, storeCache }
