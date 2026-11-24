#!/usr/bin/env node
// Preflight: Redis check with clear actionable guidance and diagnostics.
// Run: node scripts/ensure-redis.mjs (or npm run check:redis / npm run ensure:redis)
import 'dotenv/config'
import { connection, waitForRedis, getRedisEndpoint } from '../src/queue/connection.js'
import { config } from '../src/config.js'

const timeoutMs = Number(process.env.REDIS_PREFLIGHT_TIMEOUT_MS) || 3000
const endpoint = getRedisEndpoint()

console.log(`[ensure-redis] Probing Redis at ${endpoint}...`)

const ok = await waitForRedis(timeoutMs)
if (ok) {
  console.log(`[ensure-redis] OK — Redis reachable at ${endpoint}`)
  try { connection.disconnect() } catch (_) {}
  process.exit(0)
}

console.error(`\n[ensure-redis] FAIL — Redis unavailable at ${endpoint}`)
console.error(`----------------------------------------------------------------------`)
console.error(`Redis is required for background queue processing (BullMQ), including:`)
console.error(`  - Project processing pipeline and job draining`)
console.error(`  - Notification deliveries`)
console.error(`  - Scheduled project cleanup tasks`)
console.error(``)
console.error(`Remediation options:`)
console.error(`  1. Start Redis using Docker Compose (recommended for dev):`)
console.error(`     docker compose up -d redis`)
console.error(`  2. Configure connection settings in backend/.env:`)
console.error(`     REDIS_HOST=${config.redis.host || '127.0.0.1'}`)
console.error(`     REDIS_PORT=${config.redis.port || 6379}`)
console.error(`  3. In development, the API can start without Redis (degraded mode),`)
console.error(`     but workers will remain paused until Redis becomes available.`)
console.error(`----------------------------------------------------------------------\n`)

try { connection.disconnect() } catch (_) {}
process.exit(1)
