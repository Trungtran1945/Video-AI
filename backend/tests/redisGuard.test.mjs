// TDD: Redis unavailable -> workers detect state, don't spam, recover on ready.
// Run: node backend/tests/redisGuard.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { connection, isRedisReady, waitForRedis, createThrottledLogger } =
  await import('../src/queue/connection.js')

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// Deterministic: detach the real socket so no live Redis can flap state.
try { connection.disconnect() } catch (_) {}
await new Promise((r) => setTimeout(r, 50))

// 1. Detect unavailable Redis.
connection.emit('close')
assert(isRedisReady() === false, 'close -> not ready')
const t0 = Date.now()
assert((await waitForRedis(150)) === false, 'waitForRedis resolves false when down')
assert(Date.now() - t0 < 1000, 'waitForRedis does not hang')

// 2. Recover when Redis becomes available.
connection.emit('ready')
assert(isRedisReady() === true, 'ready -> ready')
assert((await waitForRedis(50)) === true, 'waitForRedis resolves true when ready')
connection.emit('close')
assert(isRedisReady() === false, 'close again -> not ready')

// 3. Throttled logger: burst collapses, no spam.
const seen = []
const realErr = console.error
console.error = (...a) => { seen.push(a.join(' ')) }
try {
  const log = createThrottledLogger(60)
  for (let i = 0; i < 5; i++) log('[Test] worker error x')
  assert(seen.length === 1, `burst of 5 logs once (got ${seen.length})`)
  await new Promise((r) => setTimeout(r, 80))
  log('[Test] worker error y')
  assert(seen.length === 2 && /suppressed/.test(seen[1]), 'next window reports suppressed count')
} finally {
  console.error = realErr
}

// 4. Workers wire throttled logging (no raw per-error spam).
const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const f of ['drainQueued.js', 'cleanupWorker.js', 'notifyWorker.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'queue', 'workers', f), 'utf8')
  assert(src.includes('createThrottledLogger'), `${f} uses throttled error logging`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
