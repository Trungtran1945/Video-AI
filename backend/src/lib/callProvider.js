/**
 * callProvider — wraps every external API call with:
 *   1. Content-hash cache check (docs/11 §3.2)
 *   2. QuotaGuard pre-check (docs/11 §4.1)
 *   3. Rate limiter acquire (docs/11 §2.2)
 *   4. Tracked execution with timing + provider_logs (docs/03 §6)
 *   5. Rate limiter release
 *   6. Cache write on success
 *
 * Contract "shared computation vs project artifact" (BE-C01):
 * - provider_cache là computation cache (content-addressed theo provider/type/
 *   input_hash), KHÔNG phải artifact store.
 * - Shared result CHỈ an toàn khi không chứa local path (text/bytes/duration/
 *   immutable identity). Mọi `audioPath/clipPath` local là project-owned artifact,
 *   ownership thuộc về `audios` + `transcript_segments.tts_clip_key` + file dưới
 *   `storage/projects/<projectId>/` của chính project (xem dubTtsAlign).
 * - Vì vậy: single-flight + persistent cache KHÔNG được trả local path của project
 *   khác cho caller. Chưa chứng minh ownership → CACHE MISS (không xóa mù quáng
 *   entry của owner khác). Filesystem path không bao giờ là auth proof.
 * - Tương lai (bytes-based materialization): provider trả bytes → mỗi caller tự
 *   ghi `clip_<hash>.mp3` riêng; lúc đó mới strip path khi store + share computation
 *   cross-project. Hiện tại single-flight key gồm projectId để chặn leak (đánh đổi
 *   1 lần synth dư khi 2 project trùng input đồng thời — an toàn hơn dedupe sai).
 */

import crypto from 'crypto'
import fs from 'node:fs'
import path from 'node:path'
import { run, queryOne } from '../db/query.js'
import { config } from '../config.js'
import { v4 as uuidv4 } from 'uuid'
import { getRateLimiter } from '../lib/rateLimiter.js'
import { classifyProviderError, ERROR_KINDS } from './providerErrors.js'
import { isCanonicalAsrCacheInput } from './asrCacheKey.js'

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

function singleFlightKey(provider, type, hash, projectId) {
  // BE-C02: single-flight chỉ share trong cùng project khi kết quả có thể chứa
  // local artifact. projectId=null (tests/legacy) giữ key cũ để backward-compat.
  if (projectId) return `${provider}\0${type}\0${hash}\0p:${projectId}`
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
 * BE-C03: không persist `cacheHit` flag (metadata của lần đọc, không phải identity).
 * Giữ nguyên artifact cho path-bound inputs (input chứa outPath → cùng file → HIT an
 * toàn, backward-compat với callProvider.cacheArtifacts.test). Canonical TTS inputs
 * (không outPath) được bảo vệ bởi ownership check khi đọc (BE-C04) thay vì strip
 * mù quáng — strip hoàn toàn đòi bytes-based materialization ở dubTtsAlign (future).
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
      [uuidv4(), provider, type, hash, JSON.stringify(withoutCacheHitFlag(result)), expiresDate]
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
function localArtifactPath(cached) {
  if (!cached || typeof cached !== 'object' || Array.isArray(cached)) return null
  for (const key of ['audioPath', 'clipPath']) {
    const p = cached[key]
    if (typeof p === 'string' && p.trim() !== '' && !isRemoteArtifact(p)) return p
  }
  return null
}
function isStaleLocalArtifact(cached) {
  const p = localArtifactPath(cached)
  if (!p) return false
  try { return !fs.existsSync(p) } catch (_) { return false }
}
// BE-C03/C04: cached có local path nhưng không chứng minh được ownership → unsafe.
// - File missing → stale (caller invalidate entry đó, không xóa cả DB).
// - projectId có + path nằm ngoài storage/projects/<projectId>/ → cross-project → MISS
//   (KHÔNG delete: entry có thể vẫn hợp lệ với owner gốc).
// - projectId null (tests/legacy generic callers) → giữ hành vi cũ (chỉ check exists)
//   để backward-compat; ownership thực sự do dubTtsAlign filesystem resume đảm nhiệm.
function isUnsafeCachedArtifact(cached, projectId) {
  const p = localArtifactPath(cached)
  if (!p) return false
  try {
    if (!fs.existsSync(p)) return true
  } catch (_) { return false }
  if (!projectId) return false
  try {
    const ownerDir = path.resolve(config.storageDir, 'projects', String(projectId))
    const abs = path.resolve(String(p))
    return !(abs === ownerDir || abs.startsWith(ownerDir + path.sep))
  } catch (_) { return false }
}
function withoutCacheHitFlag(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  if (!('cacheHit' in result)) return result
  const copy = { ...result }
  delete copy.cacheHit
  return copy
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
// Single source of truth for canonical ASR cache identity lives in
// asrCacheKey.js (buildAsrCacheInput / isCanonicalAsrCacheInput).
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
  // Canonical v2 without valid canonical identity → bypass cache.
  if (input.v === 2) return !isCanonicalAsrCacheInput(input)
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
  // BE-03: kill-switch cache toàn cục (docs/11 §3.2). Tắt → chạy provider
  // trực tiếp (vẫn rate-limit + log), không đọc/ghi provider_cache.
  if (config.providerCacheEnabled === false) {
    const direct = await executeProviderCall({ provider, type, model, fn, userId, apiKeyId, projectId, jobId, rateLimitOpts })
    if (direct && typeof direct === 'object' && !Array.isArray(direct) && !('cacheHit' in direct)) return { ...direct, cacheHit: false }
    return direct
  }
  // BE-03: TTL cấu hình thắng default 90 ngày (không đổi chữ ký hàm).
  const effectiveTtlDays = Number.isFinite(config.providerCacheTtlDays)
    ? config.providerCacheTtlDays
    : cacheTtlDays
  const skipCache = isUnsafeAsrCacheInput(type, input)
  // 1. Cache check (+ stale/unsafe local-artifact handling before provider call)
  if (!skipCache) {
    const cached = await checkCache(provider, type, model, input)
    if (cached !== null) {
      if (isStaleLocalArtifact(cached)) {
        await invalidateCacheRow(provider, type, model, input, 'provider_cache_stale_artifact')
      } else if (isUnsafeCachedArtifact(cached, projectId)) {
        // BE-C03/C04: local path không chứng minh ownership → MISS, không delete
        // mù quáng entry của owner khác. Nếu ownership không chứng minh được → MISS.
        logCacheDiag('provider_cache_ownership_miss', { provider, type, hash: inputHash(provider, type, model, input) })
      } else {
        // Still log for analytics but mark as cache hit (BE-C05, không persist flag).
        await logCall({ projectId, jobId, provider, type, model, status: 'cache_hit', durationMs: 0 })
        return { ...cached, cacheHit: true }
      }
    }
  } else {
    // Non-cacheable calls never participate in single-flight.
    const direct = await executeProviderCall({ provider, type, model, fn, userId, apiKeyId, projectId, jobId, rateLimitOpts })
    if (direct && typeof direct === 'object' && !Array.isArray(direct) && !('cacheHit' in direct)) return { ...direct, cacheHit: false }
    return direct
  }

  // 1b. Process-local single-flight: same project + cache key → one provider call.
  // BE-C02: key gồm projectId để waiter khác project không nhận audioPath project-local.
  const hash = inputHash(provider, type, model, input)
  const flightKey = singleFlightKey(provider, type, hash, projectId)
  const existing = inFlightProviderCalls.get(flightKey)
  if (existing) return existing

  const flight = (async () => {
    try {
      const result = await executeProviderCall({ provider, type, model, fn, userId, apiKeyId, projectId, jobId, rateLimitOpts })
      await storeCache(provider, type, model, input, result, effectiveTtlDays)
      // BE-C05: execution → cacheHit:false (không persist thêm trường vào DB).
      if (result && typeof result === 'object' && !Array.isArray(result) && !('cacheHit' in result)) return { ...result, cacheHit: false }
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

// BE-02: rate-limit đọc đúng DB (docs/11 §2.1). Override per-user thắng default
// hệ thống (ORDER BY user_id DESC — mẫu quotaGuardService); nhân safetyMargin
// (docs/11 §8: margin là phần dùng được, 0.8 = 80% giới hạn công bố); lỗi DB
// hoặc không có row → fallback cũ (rpm 10). Explicit rateLimitOpts thắng DB.
async function resolveRateLimitOpts(provider, userId, rateLimitOpts) {
  if (rateLimitOpts?.requestsPerMinute || rateLimitOpts?.requestsPerDay || rateLimitOpts?.concurrency) {
    return {
      requestsPerMinute: rateLimitOpts.requestsPerMinute || 10,
      requestsPerDay: rateLimitOpts.requestsPerDay || null,
      concurrency: rateLimitOpts.concurrency || 1,
    }
  }
  try {
    const row = await queryOne(
      `SELECT requests_per_minute, requests_per_day, concurrency FROM provider_rate_limits
       WHERE provider = ? AND (user_id = ? OR user_id IS NULL)
       ORDER BY user_id DESC LIMIT 1`,
      [provider, userId || null]
    )
    if (!row) return { requestsPerMinute: 10, requestsPerDay: null, concurrency: 1 }
    const margin = Number(config.providerRateLimitSafetyMargin)
    const factor = Number.isFinite(margin) && margin > 0 && margin <= 1 ? margin : 1
    return {
      requestsPerMinute: Math.max(1, Math.floor(Number(row.requests_per_minute || 10) * factor)),
      requestsPerDay: row.requests_per_day != null
        ? Math.max(1, Math.floor(Number(row.requests_per_day) * factor))
        : null,
      concurrency: Math.max(1, Number(row.concurrency || 1)),
    }
  } catch (_) {
    return { requestsPerMinute: 10, requestsPerDay: null, concurrency: 1 }
  }
}

async function executeProviderCall({ provider, type, model, fn, userId, apiKeyId, projectId, jobId, rateLimitOpts }) {
  // 2. Rate limiter
  const limiter = getRateLimiter(userId || 'system', provider, apiKeyId, await resolveRateLimitOpts(provider, userId, rateLimitOpts))

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
    // Distinguish quota vs rate-limit (TransFlow behavior): quota is NOT a
    // generic transient — it cools down the key and triggers failover, never
    // blind same-key retry. Rate-limit keeps limiter cooldown.
    const cls = classifyProviderError(err)
    const status = cls.code === 'PROVIDER_QUOTA_EXCEEDED'
      ? 'quota_exceeded'
      : cls.code === 'PROVIDER_RATE_LIMITED'
        ? 'rate_limited'
        : (cls.kind === ERROR_KINDS.TRANSIENT ? 'transient' : 'error')

    if (status === 'rate_limited') {
      limiter.markRateLimited()
    }

    await logCall({ projectId, jobId, provider, type, model, status, durationMs, error: err.message })
    // Attach structured code so stage failover can classify without re-parsing.
    try {
      if (!err.code || typeof err.code !== 'string' || !err.code.startsWith('PROVIDER_')) {
        err.errorCode = cls.code
      }
    } catch (_) {}
    throw err
  } finally {
    limiter.release()
  }
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
