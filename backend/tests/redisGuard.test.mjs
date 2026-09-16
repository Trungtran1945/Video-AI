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

// 5. Workers pause/resume on connection state (no lost jobs, no close).
for (const f of ['drainQueued.js', 'cleanupWorker.js', 'notifyWorker.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'queue', 'workers', f), 'utf8')
  assert(src.includes('isRedisReady'), `${f} imports isRedisReady`)
  assert(src.includes("connection.on('close'") && src.includes('worker.pause()'), `${f} pauses on close`)
  assert(src.includes("connection.on('end'") && src.includes('worker.pause()'), `${f} pauses on end`)
  assert(src.includes("connection.on('ready'") && src.includes('worker.resume()'), `${f} resumes on ready`)
  assert(src.includes('if (!isRedisReady()) worker.pause()'), `${f} pauses at boot when Redis down`)
  assert(!src.includes('worker.close()'), `${f} never closes worker on disconnect`)
}

// 6. Queue .add call sites skip (never throw) when Redis is down.
const cancelSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'usecases', 'cancelProjectUseCase.js'), 'utf8')
assert(cancelSrc.includes('isRedisReady()'), 'cancelProjectUseCase guards notifyQueue.add with isRedisReady')
const runnerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'runner.js'), 'utf8')
assert(runnerSrc.includes('isRedisReady()'), 'runner.js guards notifyQueue.add with isRedisReady')
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
assert(serverSrc.includes('isRedisReady()'), 'server.js guards cleanupQueue.add with isRedisReady')

// 7. DrainQueued stale-recovery query must reference a real projects column
// (schema has created_date, NOT updated_date — "no such column" otherwise).
const drainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'queue', 'workers', 'drainQueued.js'), 'utf8')
assert(!drainSrc.includes('updated_date'), 'drainQueued.js does not reference missing updated_date column')
assert(drainSrc.includes('created_date < ?'), 'drainQueued.js stale cutoff uses created_date')

// 8. Redis bắt buộc: mỗi Queue/Worker dùng dedicated connection (không share
// 1 stream cho nhiều consumer — nguyên nhân "Stream isn't writeable" lan cả 3 workers).
const connSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'queue', 'connection.js'), 'utf8')
assert(connSrc.includes('export function createRedisConnection'), 'connection.js exports createRedisConnection factory')
for (const f of ['notifyQueue.js', 'cleanupQueue.js', 'projectQueue.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'queue', f), 'utf8')
  assert(src.includes('createRedisConnection()'), `${f} uses dedicated connection`)
}
for (const f of ['drainQueued.js', 'cleanupWorker.js', 'notifyWorker.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'queue', 'workers', f), 'utf8')
  assert(src.includes('createRedisConnection()'), `${f} worker uses dedicated connection`)
}
const serverSrc2 = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
assert(serverSrc2.includes('getRedisEndpoint'), 'server.js reports Redis endpoint in boot diagnostics')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
