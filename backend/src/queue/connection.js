import IORedis from 'ioredis'
import { config } from '../config.js'

const endpoint = `${config.redis.host}:${config.redis.port}`

export const connection = new IORedis({
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: null,
  enableOfflineQueue: false,
  retryStrategy(times) {
    const delay = Math.min(times * 500, 30000)
    return delay
  },
})

let _redisReady = false
let _loggedError = false

connection.on('error', (err) => {
  _redisReady = false
  if (!_loggedError) {
    console.error(`[Redis] Connection error at ${endpoint}: ${err.message} — queue features (notifications, cleanup, job draining) are unavailable`)
    _loggedError = true
  } else {
    console.error(`[Redis] Connection error: ${err.message}`)
  }
})

connection.on('connect', () => {
  _redisReady = true
  _loggedError = false
  console.log(`[Redis] Connected to ${endpoint}`)
})

connection.on('close', () => {
  _redisReady = false
})

/** Check if Redis connection is currently ready. */
export function isRedisReady() {
  return _redisReady
}

export default connection
