import IORedis from 'ioredis'
import { config } from '../config.js'

const endpoint = `${config.redis.host}:${config.redis.port}`

export const connection = new IORedis({
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
})

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
