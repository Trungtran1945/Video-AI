import { query, queryOne } from '../db/query.js'
import { config } from '../config.js'

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

  // Get rate limit config (default: no limit)
  const limitToday = null // Can be configured per provider tier
  const limitThisMinute = null

  const percentUsed = limitToday ? (usedToday / limitToday) * 100 : 0

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
 * Get the best API key for a provider (round-robin by remaining capacity).
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

  let bestKey = null
  let bestSnapshot = null
  let lowestUsage = Infinity

  for (const key of keys) {
    // Check if this key has been rate-limited recently
    const recentLimit = await queryOne(
      `SELECT COUNT(*) as cnt FROM provider_logs
       WHERE provider = ? AND status = 'rate_limited' AND created_date >= ?`,
      [provider, new Date(Date.now() - 15 * 60 * 1000).toISOString()]
    )

    if (recentLimit?.cnt > 0) continue // Skip rate-limited keys

    const snapshot = await getQuotaSnapshot(userId, provider)
    if (snapshot.usedToday < lowestUsage) {
      lowestUsage = snapshot.usedToday
      bestKey = key
      bestSnapshot = snapshot
    }
  }

  return { apiKey: bestKey, snapshot: bestSnapshot }
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

export default {
  getQuotaSnapshot,
  checkQuotaWarning,
  selectBestApiKey,
  logProviderCallWithQuota,
}
