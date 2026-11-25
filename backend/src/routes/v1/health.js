import { Router } from 'express'
import { isRedisReady, connection } from '../../queue/connection.js'
import {
  getDbPersistenceStats,
  probeDatabaseHealth,
  PERSISTENCE_STATES,
} from '../../db.js'
import { getWriteQueueStats } from '../../db/query.js'
import { getRefreshFallbackStats } from '../../lib/refreshMetrics.js'
import { getCleanupStats } from '../../services/projectCleanup.js'
import { sanitizeStringContent } from '../../lib/responseSanitizer.js'
import { config } from '../../config.js'

export const QUEUE_STATES = Object.freeze({
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  UNAVAILABLE: 'UNAVAILABLE',
})

let _mockQueueState = null

export function setMockQueueState(state) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setMockQueueState is only allowed in test environment (NODE_ENV=test)')
  }
  _mockQueueState = state
}

export function isQueueRequired() {
  if (process.env.QUEUE_REQUIRED !== undefined) {
    return process.env.QUEUE_REQUIRED === 'true'
  }
  if (process.env.REDIS_REQUIRED !== undefined) {
    return process.env.REDIS_REQUIRED === 'true'
  }
  return config.nodeEnv === 'production'
}

export function getQueueHealth(opts = {}) {
  const targetState = opts.forceState || _mockQueueState
  if (targetState) {
    const isHealthy = targetState === QUEUE_STATES.HEALTHY
    const isDegraded = targetState === QUEUE_STATES.DEGRADED
    return {
      state: targetState,
      queueState: targetState,
      redis: isHealthy ? 'connected' : (isDegraded ? 'reconnecting' : 'disconnected'),
      bullmq: isHealthy ? 'available' : (isDegraded ? 'degraded' : 'unavailable'),
      required: isQueueRequired(),
    }
  }

  let redisOk = false
  let connStatus = 'disconnected'
  try {
    redisOk = isRedisReady()
    const conn = opts.connection || connection
    connStatus = conn?.status || (redisOk ? 'ready' : 'close')
  } catch (_) {}

  let state = QUEUE_STATES.UNAVAILABLE
  if (redisOk && connStatus === 'ready') {
    state = QUEUE_STATES.HEALTHY
  } else if (connStatus === 'connecting' || connStatus === 'reconnecting' || connStatus === 'connect') {
    state = QUEUE_STATES.DEGRADED
  } else {
    state = QUEUE_STATES.UNAVAILABLE
  }

  return {
    state,
    queueState: state,
    redis: state === QUEUE_STATES.HEALTHY ? 'connected' : (state === QUEUE_STATES.DEGRADED ? 'reconnecting' : 'disconnected'),
    bullmq: state === QUEUE_STATES.HEALTHY ? 'available' : (state === QUEUE_STATES.DEGRADED ? 'degraded' : 'unavailable'),
    required: isQueueRequired(),
    status: connStatus,
  }
}

export async function buildHealthResponse() {
  const queueHealth = getQueueHealth()
  const health = await probeDatabaseHealth()
  const persistence = getDbPersistenceStats()
  const writes = getWriteQueueStats()

  const status = health.state === PERSISTENCE_STATES.HEALTHY
    ? 'ok'
    : health.state === PERSISTENCE_STATES.DEGRADED
      ? 'degraded'
      : 'unavailable'

  let durableCleanup = 'available'
  let cleanupStats = { pending: 0, failed: 0, oldestPendingAgeMs: 0, lastFailureAt: null }
  try {
    cleanupStats = await getCleanupStats()
  } catch (_) {
    durableCleanup = 'unavailable'
  }

  let refreshFallbackStats = { count: 0, lastAt: null, deprecated: true, removalTarget: 'v2' }
  try {
    refreshFallbackStats = getRefreshFallbackStats()
  } catch (_) {
    refreshFallbackStats = { count: 0, lastAt: null, deprecated: true, status: 'unknown' }
  }

  return {
    status,
    redis: queueHealth.redis,
    bullmq: queueHealth.bullmq,
    durableCleanup,
    cleanup: cleanupStats,
    queueState: queueHealth.state,
    queue: {
      state: queueHealth.state,
      queueState: queueHealth.state,
      redis: queueHealth.redis,
      bullmq: queueHealth.bullmq,
      required: queueHealth.required,
    },
    database: {
      ...persistence,
      persistenceState: health.state,
      consecutiveSaveFailures: health.consecutiveSaveFailures,
      lastSuccessfulSaveAt: health.lastSuccessfulSaveAt,
      lastSaveError: sanitizeStringContent(health.lastSaveError),
      maxSaveFailures: health.maxSaveFailures,
    },
    writes,
    auth: { refreshFallback: refreshFallbackStats },
  }
}

export async function buildReadyResponse() {
  const queueHealth = getQueueHealth()
  const queueRequired = isQueueRequired()
  const health = await probeDatabaseHealth()

  const dbOk = health.state !== PERSISTENCE_STATES.WRITE_BLOCKED
  const queueBlocked = queueRequired && queueHealth.state === QUEUE_STATES.UNAVAILABLE
  const ready = dbOk && !queueBlocked

  const body = {
    ready,
    database: {
      persistenceState: health.state,
      consecutiveSaveFailures: health.consecutiveSaveFailures,
      lastSuccessfulSaveAt: health.lastSuccessfulSaveAt,
      lastSaveError: sanitizeStringContent(health.lastSaveError),
    },
    redis: queueHealth.redis,
    queue: {
      state: queueHealth.state,
      queueState: queueHealth.state,
      required: queueRequired,
    },
  }

  return {
    ready,
    statusCode: ready ? 200 : 503,
    body,
  }
}

const router = Router()

router.get('/', async (req, res) => {
  const payload = await buildHealthResponse()
  res.json(payload)
})

router.get('/ready', async (req, res) => {
  const { statusCode, body } = await buildReadyResponse()
  res.status(statusCode).json(body)
})

export default router
