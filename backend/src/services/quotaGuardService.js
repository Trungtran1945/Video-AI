import { query, queryOne } from '../db/query.js'
import { config } from '../config.js'
import { isProviderAvailable } from '../lib/providerHealth.js'

/**
 * QuotaGuardService — monitors API quota usage per provider
 * Returns quota snapshot and warnings when approaching limits.
 */

/**
 * Get quota snapshot for a user + provider combination.
 * @param {string} userId
 * @param {string} provider
 * @returns {Promise<QuotaSnapshot>}
 */
export async function getQuotaSnapshot(userId, provider) {
  const now = new Date()
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const oneMinuteAgo = new Date(now.getTime() - 60 * 1000).toISOString()

  // Count calls in last 24h
  const dailyResult = await queryOne(
    `SELECT COUNT(*) as cnt FROM provider_logs pl
     JOIN projects p ON pl.project_id = p.id
     WHERE p.user_id = ? AND pl.provider = ? AND pl.created_date >= ?`,
    [userId, provider, oneDayAgo]
  )
  const usedToday = dailyResult?.cnt || 0

  // Count calls in last minute
  const minuteResult = await queryOne(
    `SELECT COUNT(*) as cnt FROM provider_logs pl
     JOIN projects p ON pl.project_id = p.id
     WHERE p.user_id = ? AND pl.provider = ? AND pl.created_date >= ?`,
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

  // percentUsed = max(daily%, minute%)
  const pctDaily = limitToday ? usedToday / limitToday : 0
  const pctMinute = limitThisMinute ? usedThisMinute / limitThisMinute : 0
  const percentUsed = Math.max(pctDaily, pctMinute) * 100

  return {
    provider,
    usedToday,
    limitToday,
    usedThisMinute,
    limitThisMinute,
    percentUsed,
  }
}

/**
 * Check if user is approaching quota limit and return warning if needed.
 * @param {string} userId
 * @param {string} provider
 * @returns {Promise<{warning: object|null}>}
 */
export async function checkQuotaWarning(userId, provider) {
  const snapshot = await getQuotaSnapshot(userId, provider)
  const threshold = config.quotaWarningThreshold || 0.8

  if (snapshot.percentUsed >= threshold * 100) {
    return {
      warning: {
        type: 'quota_risk',
        provider: snapshot.provider,
        percentUsed: snapshot.percentUsed,
        usedToday: snapshot.usedToday,
        limitToday: snapshot.limitToday,
        message: `Đã sử dụng ${snapshot.percentUsed.toFixed(1)}% quota ${provider} hôm nay`,
      },
    }
  }

  return { warning: null }
}

/**
 * Get the best API key for a provider (priority order + per-key cooldown).
 * Skips keys the failover health marks unavailable (429/quota/auth cooldown on
 * THAT key only — never a global skip). First available in priority order wins.
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
  if (snapshot.limitToday == null) return { allowed: true, warning: null }
  const est = Number.isFinite(Number(estimatedRequests)) && Number(estimatedRequests) > 0
    ? Number(estimatedRequests)
    : 10
  if (snapshot.percentUsed >= threshold * 100 && snapshot.usedToday + est > snapshot.limitToday) {
    return {
      allowed: true,
      warning: {
        type: 'quota_risk',
        provider: snapshot.provider,
        percentUsed: snapshot.percentUsed,
        usedToday: snapshot.usedToday,
        limitToday: snapshot.limitToday,
        estimatedRequests: est,
        estimatedShortfall: snapshot.usedToday + est - snapshot.limitToday,
      },
    }
  }
  return { allowed: true, warning: null }
}

export default {
  getQuotaSnapshot,
  checkQuotaWarning,
  selectBestApiKey,
  precheckStage,
  logProviderCallWithQuota,
}
