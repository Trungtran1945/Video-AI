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
import fs from 'node:fs'
import { run, queryOne } from '../db/query.js'
import { v4 as uuidv4 } from 'uuid'
import { getRateLimiter, RateLimitExhaustedError } from '../lib/rateLimiter.js'
import { classifyProviderError, ERROR_KINDS } from './providerErrors.js'

/**
 * Compute SHA-256 hash of normalized input for cache key.
 * @param {string} provider
 * @param {string} type
 * @param {string} model
 * @param {*} input
 * @returns {string} hex hash
 */
function normalizeInput(input) {
  if (typeof input === 'string') return input.trim()
  if (typeof input !== 'object' || input === null) return input
  if (Array.isArray(input)) return input.map(normalizeInput)
  const sorted = {}
  for (const key of Object.keys(input).sort()) {
    sorted[key] = normalizeInput(input[key])
  }
  return sorted
}

function inputHash(provider, type, model, input) {
  const normalized = normalizeInput(input)
  const payload = JSON.stringify({ provider, type, model, input: normalized })
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
// Process-local single-flight for cacheable calls (INSTANCE_MODE=single,
// sql.js single-writer). Same cache key → first request calls provider,
// later concurrent requests await the same promise. No distributed lock.
const inFlightProviderCalls = new Map()

function singleFlightKey(provider, type, hash) {
  return `${provider}\0${type}\0${hash}`
}

// Structured cache diagnostics (never throws, never logs secrets/audio).
// Safe fields only: provider, type, hash prefix, error message snippet.
function logCacheDiag(event, { provider, type, hash, error } = {}) {
  try {
    const safe = {
      event,
      provider: String(provider ?? ''),
      type: String(type ?? ''),
      hashPrefix: String(hash ?? '').slice(0, 12),
    }
    if (error) safe.error = String(error?.message || error).slice(0, 200)
    console.warn(`[provider_cache] ${event} ${JSON.stringify(safe)}`)
  } catch (_) {}
}

async function checkCache(provider, type, model, input) {
  let hash = ''
  try {
    hash = inputHash(provider, type, model, input)
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
    try {
      return JSON.parse(row.result)
    } catch (parseErr) {
      logCacheDiag('provider_cache_parse_error', { provider, type, hash, error: parseErr })
      try {
        await run(`DELETE FROM provider_cache WHERE provider = ? AND type = ? AND input_hash = ?`, [provider, type, hash])
      } catch (_) {}
      return null
    }
  } catch (err) {
    // Availability preserved: cache errors never fail the provider request.
    logCacheDiag('provider_cache_check_error', { provider, type, hash, error: err })
    return null
  }
}

/**
 * Store result in provider cache.
 */
async function storeCache(provider, type, model, input, result, ttlDays) {
  let hash = ''
  try {
    hash = inputHash(provider, type, model, input)
    const expiresDate = ttlDays
      ? new Date(Date.now() + ttlDays * 86400000).toISOString()
      : null
    await run(
      `INSERT OR REPLACE INTO provider_cache (id, provider, type, input_hash, result, expires_date) VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), provider, type, hash, JSON.stringify(result), expiresDate]
    )
  } catch (err) {
    // Cache write failure is non-fatal
    logCacheDiag('provider_cache_write_error', { provider, type, hash, error: err })
  }
}

async function invalidateCacheRow(provider, type, model, input, reason) {
  try {
    const hash = inputHash(provider, type, model, input)
    await run(`DELETE FROM provider_cache WHERE provider = ? AND type = ? AND input_hash = ?`, [provider, type, hash])
    logCacheDiag(reason || 'provider_cache_stale_artifact', { provider, type, hash })
  } catch (err) {
    logCacheDiag('provider_cache_check_error', { provider, type, error: err })
  }
}

function isRemoteArtifact(p) {
  const s = String(p || '').trim()
  return /^(https?:\/\/|data:|blob:)/i.test(s)
}
function isStaleLocalArtifact(cached) {
  if (!cached || typeof cached !== 'object' || Array.isArray(cached)) return false
  const p = cached.audioPath
  if (typeof p !== 'string' || p.trim() === '') return false
  if (isRemoteArtifact(p)) return false
  try { return !fs.existsSync(p) } catch (_) { return false }
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
// ASR inputs keyed by tmp file PATH alone are unsafe: the same path is reused
// across runs with different audio. Require a content hash for cache use;
// otherwise bypass cache entirely (still executes + logs). Canonical v2
// uses audioContentHash; legacy fileHash/fileContentHash/contentHash still
// accepted for backward-compat (old rows miss once v2 fields differ).
function isUnsafeAsrCacheInput(type, input) {
  if (type !== 'asr' || !input || typeof input !== 'object' || Array.isArray(input)) return false
  if (typeof input.file === 'string' && input.file) {
    return !input.fileHash && !input.fileContentHash && !input.contentHash && !input.audioContentHash
  }
  // Canonical ASR identity requires a content hash; without it bypass cache.
  if (input.v === 2) return !input.audioContentHash
  return false
}

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
  const skipCache = isUnsafeAsrCacheInput(type, input)
  // 1. Cache check (+ stale local-artifact invalidation before provider call)
  if (!skipCache) {
    const cached = await checkCache(provider, type, model, input)
    if (cached !== null) {
      if (isStaleLocalArtifact(cached)) {
        await invalidateCacheRow(provider, type, model, input, 'provider_cache_stale_artifact')
      } else {
        // Still log for analytics but mark as cache hit
        await logCall({ projectId, jobId, provider, type, model, status: 'cache_hit', durationMs: 0 })
        return cached
      }
    }
  } else {
    // Non-cacheable calls never participate in single-flight.
    return executeProviderCall({ provider, type, model, fn, userId, apiKeyId, projectId, jobId, rateLimitOpts })
  }

  // 1b. Process-local single-flight: same cache key → one provider call.
  const hash = inputHash(provider, type, model, input)
  const flightKey = singleFlightKey(provider, type, hash)
  const existing = inFlightProviderCalls.get(flightKey)
  if (existing) return existing

  const flight = (async () => {
    try {
      const result = await executeProviderCall({ provider, type, model, fn, userId, apiKeyId, projectId, jobId, rateLimitOpts })
      await storeCache(provider, type, model, input, result, cacheTtlDays)
      return result
    } finally {
      // Always cleanup so retries are possible and no memory leaks.
      if (inFlightProviderCalls.get(flightKey) === flightPromise) {
        inFlightProviderCalls.delete(flightKey)
      }
    }
  })()
  // Store the promise synchronously before any await so concurrent
  // same-key callers observe it and await instead of calling provider.
  const flightPromise = flight
  inFlightProviderCalls.set(flightKey, flightPromise)
  return flightPromise
}

async function executeProviderCall({ provider, type, model, fn, userId, apiKeyId, projectId, jobId, rateLimitOpts }) {
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

    return result
  } catch (err) {
    const durationMs = Date.now() - startMs
    // 429/quota keeps 'rate_limited' (with limiter cooldown); other
    // transient failures (503/timeout) are logged distinctly.
    const status = isRateLimitError(err)
      ? 'rate_limited'
      : (classifyProviderError(err).kind === ERROR_KINDS.TRANSIENT ? 'transient' : 'error')

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

export function __clearInFlightForTests() {
  inFlightProviderCalls.clear()
}

export function __inFlightSizeForTests() {
  return inFlightProviderCalls.size
}

export default { callProvider, checkCache, storeCache }
