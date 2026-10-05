import { query, queryOne } from '../db/query.js'
import { config } from '../config.js'
import { isProviderAvailable } from '../lib/providerHealth.js'

/**
 * QuotaGuardService — monitors API quota usage per provider
 * Returns quota snapshot and warnings when approaching limits.
 *
 * BE-Q01 accounting contract (task §4.1 — quota usage ≠ COUNT(provider_logs)):
 * - application call: một lần stage/business logic cần provider (có thể cache-hit,
 *   failover nhiều attempt, hoặc local/mock không gọi mạng).
 * - provider attempt: một lần gọi mạng tới provider (mỗi fn() trong failover).
 * - successful external request (status 'ok'/'success'): attempt tới provider và
 *   thành công — DUY NHẤT loại này tính quota usage (xem isQuotaCountingProviderLog).
 * - rate-limited external request (status 'rate_limited'): provider từ chối (429/
 *   throttling), không tiêu thụ quota allocation — KHÔNG tính (retry thành công
 *   sẽ tính lúc đó; tính cả reject là phạt 2 lần).
 * - quota-exceeded request (status 'quota_exceeded'): provider từ chối vì hết quota —
 *   KHÔNG tính (không có consumption mới; đếm nó chỉ làm số liệu thêm nhiễu).
 * - cache hit (status 'cache_hit'): provider không hề được gọi (callProvider DB-hit)
 *   — KHÔNG tính.
 * - local/mock execution: không gọi mạng — KHÔNG tính (mock không ghi provider_logs
 *   qua callProvider; nếu có log 'ok' từ mock thì vẫn tính — xem lưu ý dưới).
 * Lưu ý: 'transient'/'error' (timeout/network/lỗi) cũng KHÔNG tính — chỉ confirmed
 * success mới là consumption. Snapshot là per-user/per-provider (provider_logs KHÔNG
 * có cột api_key_id — xem schema.js provider_logs — nên per-key quota thật đòi
 * migration, ngoài phạm vi task này; KHÔNG fake per-key bằng cách chia quota).
 */

/**
 * BE-Q02: source of truth duy nhất cho "status nào tính quota" (task §4.2/4.3).
 * Không duplicate danh sách status ở module khác — mọi COUNT quota phải qua đây.
 * @param {*} status provider_logs.status
 * @returns {boolean} true = attempt thành công tới provider, tính vào quota usage.
 */
export function isQuotaCountingProviderLog(status) {
  const s = String(status || '').trim().toLowerCase()
  // 'ok' = callProvider/tracked success; 'success' = logProviderCallWithQuota legacy default.
  return s === 'ok' || s === 'success'
}

/**
 * Get quota snapshot for a user + provider combination.
 * BE-Q06 contract: snapshot là per-user/per-provider (KHÔNG phải key-specific) —
 * provider_logs không có cột api_key_id nên cùng một snapshot được chia sẻ cho mọi
 * key của user+provider trong selectBestApiKey. Tên giữ nguyên để không orphan
 * callers (routes/v1/providers.js, tests); KHÔNG đặt tên kiểu apiKeySnapshot.
 * @param {string} userId
 * @param {string} provider
 * @returns {Promise<QuotaSnapshot>} gồm daily/minute độc lập (BE-Q04) + các field
 *   cũ giữ backward-compat; percentUsed = max() cũ, DEPRECATED (dùng daily.percent).
 */
/**
 * Format bound theo đúng SQLite datetime('now') ('YYYY-MM-DD HH:MM:SS', UTC).
 * So sánh trực tiếp ISO string ('...T...') với created_date ('... ...') sai vì
 * ' ' < 'T' — minute window sẽ không bao giờ khớp row nào (undercount hệ thống).
 */
function toSqliteUtc(date) {
  return new Date(date).toISOString().slice(0, 19).replace('T', ' ')
}

export async function getQuotaSnapshot(userId, provider) {
  const now = new Date()
  const oneDayAgo = toSqliteUtc(new Date(now.getTime() - 24 * 60 * 60 * 1000))
  const oneMinuteAgo = toSqliteUtc(new Date(now.getTime() - 60 * 1000))

  // BE-Q02: chỉ COUNT successful external requests (ok/success). cache_hit,
  // quota_exceeded, rate_limited, transient, error đều KHÔNG tính.
  const dailyResult = await queryOne(
    `SELECT COUNT(*) as cnt FROM provider_logs pl
     JOIN projects p ON pl.project_id = p.id
     WHERE p.user_id = ? AND pl.provider = ? AND pl.created_date >= ?
       AND pl.status IN ('ok', 'success')`,
    [userId, provider, oneDayAgo]
  )
  const usedToday = dailyResult?.cnt || 0

  // Count successful calls in last minute
  const minuteResult = await queryOne(
    `SELECT COUNT(*) as cnt FROM provider_logs pl
     JOIN projects p ON pl.project_id = p.id
     WHERE p.user_id = ? AND pl.provider = ? AND pl.created_date >= ?
       AND pl.status IN ('ok', 'success')`,
    [userId, provider, oneMinuteAgo]
  )
  const usedThisMinute = minuteResult?.cnt || 0

  // Get rate limit config from provider_rate_limits table
  const limit = await queryOne(
    `SELECT * FROM provider_rate_limits
     WHERE provider = ? AND (user_id = ? OR user_id IS NULL)
     ORDER BY user_id DESC LIMIT 1`,
    [provider, userId]
  )
  const limitToday = limit?.requests_per_day || null
  const limitThisMinute = limit?.requests_per_minute || null

  // BE-Q04: daily/minute độc lập (limit null → percent null, không chia 0).
  const dailyPercent = limitToday ? (usedToday / limitToday) * 100 : null
  const minutePercent = limitThisMinute ? (usedThisMinute / limitThisMinute) * 100 : null
  // percentUsed giữ nguyên = max() cũ cho backward-compat — DEPRECATED.
  // Consumer mới PHẢI dùng daily.percent / minute.percent (FE-Q02).
  const pctDaily = limitToday ? usedToday / limitToday : 0
  const pctMinute = limitThisMinute ? usedThisMinute / limitThisMinute : 0
  const percentUsed = Math.max(pctDaily, pctMinute) * 100

  return {
    provider,
    usedToday,
    limitToday,
    usedThisMinute,
    limitThisMinute,
    /** @deprecated dùng daily.percent — max(daily,minute) cũ gây nhầm minute spike thành daily (P1-DM). */
    percentUsed,
    daily: { used: usedToday, limit: limitToday, percent: dailyPercent },
    minute: { used: usedThisMinute, limit: limitThisMinute, percent: minutePercent },
  }
}

/**
 * Check if user is approaching quota limit and return warning if needed.
 * BE-Q05 (task §4.5): warning tách scope — daily trước, minute sau. Daily giữ
 * type 'quota_risk' để PipelineStatus (đọc type + message) tương thích; minute dùng
 * type 'minute_rate_limit_risk' (FE-Q03 đọc thêm, fallback 'quota_risk' vẫn hiển thị).
 * Không warn daily giả từ minute spike (P1-DM).
 * @param {string} userId
 * @param {string} provider
 * @returns {Promise<{warning: object|null}>}
 */
export async function checkQuotaWarning(userId, provider) {
  const snapshot = await getQuotaSnapshot(userId, provider)
  const threshold = config.quotaWarningThreshold || 0.8

  if (snapshot.daily.percent != null && snapshot.daily.percent >= threshold * 100) {
    return {
      warning: {
        type: 'quota_risk',
        scope: 'daily',
        provider: snapshot.provider,
        percentUsed: snapshot.percentUsed,
        percent: snapshot.daily.percent,
        usedToday: snapshot.usedToday,
        limitToday: snapshot.limitToday,
        message: `Đã sử dụng ${snapshot.daily.percent.toFixed(1)}% quota ${provider} hôm nay`,
      },
    }
  }

  if (snapshot.minute.percent != null && snapshot.minute.percent >= threshold * 100) {
    return {
      warning: {
        type: 'minute_rate_limit_risk',
        scope: 'minute',
        provider: snapshot.provider,
        percentUsed: snapshot.percentUsed,
        percent: snapshot.minute.percent,
        usedThisMinute: snapshot.usedThisMinute,
        limitThisMinute: snapshot.limitThisMinute,
        message: `Rate limit/phút ${provider} gần đầy (${snapshot.minute.percent.toFixed(1)}% — ${snapshot.usedThisMinute}/${snapshot.limitThisMinute})`,
      },
    }
  }

  return { warning: null }
}

/**
 * Get the best API key for a provider (priority order + per-key cooldown).
 * Skips keys the failover health marks unavailable (429/quota/auth cooldown on
 * THAT key only — never a global skip). First available in priority order wins.
 * BE-Q06 contract (task §4.6): `snapshot` là per-user/per-provider (user/provider-
 * level, KHÔNG phải key-specific) — cùng một snapshot object được trả kèm mọi key
 * vì provider_logs không có cột api_key_id. Caller KHÔNG được đọc snapshot như
 * usage của riêng key. Per-key quota thật đòi migration (ngoài phạm vi); KHÔNG
 * fake bằng cách chia quota user cho số key.
 * @param {string} userId
 * @param {string} provider
 * @returns {Promise<{apiKey: object|null, snapshot: QuotaSnapshot|null}>}
 */
export async function selectBestApiKey(userId, provider) {
  const keys = await query(
    `SELECT * FROM api_keys WHERE user_id = ? AND provider = ? AND is_active = 1 ORDER BY priority ASC, created_date ASC`,
    [userId, provider]
  )

  if (!keys.length) return { apiKey: null, snapshot: null }

  const snapshot = await getQuotaSnapshot(userId, provider)
  for (const key of keys) {
    try {
      if (!isProviderAvailable({ provider, apiKeyId: key.id })) continue
    } catch (_) {}
    return { apiKey: key, snapshot }
  }

  return { apiKey: null, snapshot }
}

/**
 * Log provider call with quota tracking.
 * @param {object} params
 */
export async function logProviderCallWithQuota({ projectId, jobId, provider, type, model, tokensIn, tokensOut, costUsd, durationMs, status, error }) {
  const { run } = await import('../db/query.js')
  const { v4: uuidv4 } = await import('uuid')

  await run(
    `INSERT INTO provider_logs (id, project_id, job_id, provider, type, model, tokens_in, tokens_out, cost_usd, duration_ms, status, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv4(),
      projectId || null,
      jobId || null,
      provider,
      type || null,
      model || null,
      tokensIn || 0,
      tokensOut || 0,
      costUsd || 0,
      durationMs || 0,
      status || 'success',
      error || null,
    ]
  )
}

/**
 * Pre-check before enqueueing a request-heavy stage (docs/11 §4.1).
 * Warn-only: never blocks the job ({ allowed: true } always).
 * Warns when usage is past the threshold AND the estimate overruns today's limit.
 * @param {string} userId
 * @param {string} provider
 * @param {number} [estimatedRequests]
 * @returns {Promise<{allowed: boolean, warning: object|null}>}
 */
export async function precheckStage(userId, provider, estimatedRequests = 10) {
  const snapshot = await getQuotaSnapshot(userId, provider)
  const threshold = config.quotaWarningThreshold || 0.8
  const est = Number.isFinite(Number(estimatedRequests)) && Number(estimatedRequests) > 0
    ? Number(estimatedRequests)
    : 10
  // BE-Q05: daily warn chỉ khi estimate vượt daily limit (không warn giả từ minute
  // spike). Minute warn theo window minute tương ứng (estimate là daily-scale nên
  // không áp cho minute). Daily trước, minute sau.
  if (snapshot.limitToday != null
    && snapshot.daily.percent != null && snapshot.daily.percent >= threshold * 100
    && snapshot.usedToday + est > snapshot.limitToday) {
    return {
      allowed: true,
      warning: {
        type: 'quota_risk',
        scope: 'daily',
        provider: snapshot.provider,
        percentUsed: snapshot.percentUsed,
        percent: snapshot.daily.percent,
        usedToday: snapshot.usedToday,
        limitToday: snapshot.limitToday,
        estimatedRequests: est,
        estimatedShortfall: snapshot.usedToday + est - snapshot.limitToday,
        message: `Đã sử dụng ${snapshot.daily.percent.toFixed(1)}% quota ${provider} hôm nay`,
      },
    }
  }
  if (snapshot.minute.percent != null && snapshot.minute.percent >= threshold * 100) {
    return {
      allowed: true,
      warning: {
        type: 'minute_rate_limit_risk',
        scope: 'minute',
        provider: snapshot.provider,
        percentUsed: snapshot.percentUsed,
        percent: snapshot.minute.percent,
        usedThisMinute: snapshot.usedThisMinute,
        limitThisMinute: snapshot.limitThisMinute,
        estimatedRequests: est,
        message: `Rate limit/phút ${provider} gần đầy (${snapshot.minute.percent.toFixed(1)}% — ${snapshot.usedThisMinute}/${snapshot.limitThisMinute})`,
      },
    }
  }
  return { allowed: true, warning: null }
}

export default {
  getQuotaSnapshot,
  isQuotaCountingProviderLog,
  checkQuotaWarning,
  selectBestApiKey,
  precheckStage,
  logProviderCallWithQuota,
}
