import IORedis from 'ioredis'
import { config } from '../config.js'

export const connection = new IORedis({
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: null,
})

connection.on('error', (err) => {
  console.error('[Redis] Connection error:', err.message)
})

connection.on('connect', () => {
  console.log('[Redis] Connected')
})

export default connection
