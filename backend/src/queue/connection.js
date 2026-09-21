import IORedis from 'ioredis'
import { config } from '../config.js'

const endpoint = `${config.redis.host}:${config.redis.port}`

const redisOptions = {
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: null,
  // Deliberately false: commands must fail fast with a clear diagnostic
  // instead of silently queueing against a dead stream.
  enableOfflineQueue: false,
  retryStrategy(times) {
    const delay = Math.min(times * 500, 30000)
    return delay
  },
}

export const connection = new IORedis(redisOptions)

/**
 * Dedicated connection factory (Redis bắt buộc — BullMQ best practice).
 * Mỗi Queue/Worker phải có instance riêng: share 1 stream cho nhiều
 * consumer gây tranh chấp blocking connection → "Stream isn't writeable".
 * Instance này không chạm tới _redisReady signalling (chỉ `connection`
 * chính làm điều đó).
 */
export function createRedisConnection() {
  return new IORedis(redisOptions)
}

/** Human-readable endpoint for boot diagnostics (host:port). */
export function getRedisEndpoint() {
  return endpoint
}

/**
 * Per-connection readiness (BullMQ/ioredis).
 * The shared `_redisReady` flag only reflects the MAIN connection — it must
 * never be used to gate commands on a DEDICATED Queue/Worker connection.
 * A dedicated instance is writable only when `status === 'ready'`
 * ('ready', not 'connect').
 */
export function isConnectionReady(conn) {
  try {
    return !!conn && conn.status === 'ready'
  } catch (_) {
    return false
  }
}

/**
 * Resolve true once the given connection emits `ready`, false after
 * timeoutMs without throwing. Never rejects.
 */
export function waitForConnection(conn, timeoutMs = 5000) {
  return new Promise((resolve) => {
    try {
      if (isConnectionReady(conn)) return resolve(true)
    } catch (_) {
      return resolve(false)
    }
    let done = false
    const cleanup = () => {
      try { clearTimeout(timer) } catch (_) {}
      try { conn?.off?.('ready', onReady) } catch (_) {}
    }
    const onReady = () => {
      if (done) return
      done = true
      cleanup()
      resolve(true)
    }
    const timer = setTimeout(() => {
      if (done) return
      done = true
      cleanup()
      resolve(false)
    }, timeoutMs)
    try {
      conn?.once?.('ready', onReady)
    } catch (_) {
      if (!done) {
        done = true
        cleanup()
        resolve(false)
      }
    }
  })
}

/** True for the ioredis "not writable + offline queue disabled" rejection. */
export function isStreamNotWritableError(err) {
  const m = String(err?.message || '')
  return m.includes("Stream isn't writeable") || m.includes('enableOfflineQueue')
}

/**
 * Attach throttled error logging to a DEDICATED connection immediately after
 * creation (before any Queue/Worker uses it). Returns the throttled logger
 * so callers can reuse it for worker errors.
 */
export function attachDedicatedLogging(conn, label = 'Redis') {
  const log = createThrottledLogger(30000)
  try {
    conn?.on?.('error', (err) => {
      log(`[${label}] Redis error: ${err?.message || err}`)
    })
  } catch (_) {}
  return log
}

let _redisReady = false

/** Collapse rapid repeats into one log line + suppressed count (no spam). */
export function createThrottledLogger(intervalMs = 30000) {
  let last = 0
  let suppressed = 0
  return (msg) => {
    const now = Date.now()
    if (now - last < intervalMs) {
      suppressed++
      return
    }
    if (suppressed > 0) {
      console.error(`${msg} (and ${suppressed} similar message(s) suppressed)`)
      suppressed = 0
    } else {
      console.error(msg)
    }
    last = now
  }
}

const logRedisError = createThrottledLogger(30000)

connection.on('error', (err) => {
  _redisReady = false
  logRedisError(
    `[Redis] Connection error at ${endpoint}: ${err.message} — queue features (notifications, cleanup, job draining) are unavailable`
  )
})

// 'ready' (not 'connect'): the stream can actually accept commands.
connection.on('ready', () => {
  _redisReady = true
  console.log(`[Redis] Connected to ${endpoint}`)
})

connection.on('close', () => {
  _redisReady = false
})

connection.on('end', () => {
  _redisReady = false
})

/** Check if Redis connection is currently ready. */
export function isRedisReady() {
  return _redisReady
}

/** Resolve true once ready, false after timeoutMs without throwing. */
export function waitForRedis(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (_redisReady) return resolve(true)
    const started = Date.now()
    const timer = setInterval(() => {
      if (_redisReady) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer)
        resolve(false)
      }
    }, 50)
  })
}

export default connection
