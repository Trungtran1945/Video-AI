// Preflight: Redis bắt buộc — fail fast với diagnostic rõ ràng.
// Run: npm run check:redis (from backend/)
import { connection, waitForRedis, getRedisEndpoint } from '../src/queue/connection.js'

const ok = await waitForRedis(3000)
if (ok) {
  console.log(`[check:redis] OK — Redis reachable at ${getRedisEndpoint()}`)
  try { connection.disconnect() } catch (_) {}
  process.exit(0)
}
console.error(`[check:redis] FAIL — Redis unavailable at ${getRedisEndpoint()} (REDIS_HOST/REDIS_PORT in backend/.env, hoặc: docker compose up redis)`)
try { connection.disconnect() } catch (_) {}
process.exit(1)
