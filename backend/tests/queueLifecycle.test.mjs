// Queue lifecycle: dedicated connections must be READY before Workers issue
// commands (root cause of "Stream isn't writeable and enableOfflineQueue
// options is false"). Uses fake EventEmitter connections — no live Redis.
// Run: node backend/tests/queueLifecycle.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'

const { connection, isConnectionReady, waitForConnection, isStreamNotWritableError, attachDedicatedLogging, createThrottledLogger } =
  await import('../src/queue/connection.js')

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// Detach real socket so live Redis cannot flap these unit checks.
try { connection.disconnect() } catch (_) {}
await new Promise((r) => setTimeout(r, 30))

// 1. isConnectionReady reflects the DEDICATED stream, not the shared flag.
assert(isConnectionReady({ status: 'ready' }) === true, 'status ready -> ready')
assert(isConnectionReady({ status: 'connect' }) === false, 'status connect -> not ready')
assert(isConnectionReady({ status: 'close' }) === false, 'status close -> not ready')
assert(isConnectionReady(null) === false, 'null conn -> not ready')

// 2. waitForConnection resolves true when already ready.
assert((await waitForConnection({ status: 'ready', once() {} }, 50)) === true, 'already ready resolves true')

// 3. waitForConnection resolves true when the dedicated stream turns ready.
{
  const fake = new EventEmitter()
  fake.status = 'connect'
  const p = waitForConnection(fake, 500)
  setTimeout(() => { fake.status = 'ready'; fake.emit('ready') }, 30)
  assert((await p) === true, 'emitted ready resolves true')
}

// 4. waitForConnection resolves false (never throws) on timeout.
{
  const fake = new EventEmitter()
  fake.status = 'connect'
  const t0 = Date.now()
  assert((await waitForConnection(fake, 80)) === false, 'timeout resolves false')
  assert(Date.now() - t0 < 1000, 'waitForConnection does not hang')
}

// 5. Stream error classifier (what must become a queue skip, not a pipeline failure).
assert(isStreamNotWritableError(new Error("Stream isn't writeable and enableOfflineQueue options is false")) === true, 'stream error classified')
assert(isStreamNotWritableError(new Error('ECONNREFUSED')) === false, 'unrelated error not classified')

// 6. attachDedicatedLogging wires an error listener immediately (before use).
{
  const fake = new EventEmitter()
  const log = attachDedicatedLogging(fake, 'TestQueue')
  assert(typeof log === 'function', 'returns throttled logger')
  assert(fake.listenerCount('error') >= 1, 'error listener attached immediately')
  // Must not throw / spam when the stream errors.
  fake.emit('error', new Error("Stream isn't writeable and enableOfflineQueue options is false"))
  assert(true, 'dedicated error does not throw')
}

// 7. Workers use the safe factory lifecycle (no top-level Worker before READY).
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workerFiles = {
  'drainQueued.js': 'startDrainQueuedWorker',
  'notifyWorker.js': 'startNotifyWorker',
  'cleanupWorker.js': 'startCleanupWorker',
}
for (const [f, factory] of Object.entries(workerFiles)) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'queue', 'workers', f), 'utf8')
  assert(src.includes(`export async function ${factory}`), `${f} exposes ${factory} factory`)
  assert(src.includes('attachDedicatedLogging'), `${f} attaches dedicated error logging immediately`)
  assert(src.includes('waitForConnection'), `${f} waits for dedicated READY before Worker`)
  assert(src.includes('isConnectionReady'), `${f} gates pause on dedicated readiness`)
  assert(src.includes('createThrottledLogger'), `${f} throttles worker errors`)
  assert(!src.includes('worker.close()'), `${f} never closes worker on disconnect`)
  assert(!src.match(/^const worker = new Worker/m), `${f} has no top-level Worker before ready`)
}

// 8. Queues expose isolated safeAdd (never raw .add into the pipeline).
for (const [f, fn] of [['notifyQueue.js', 'safeAddNotify'], ['cleanupQueue.js', 'safeAddCleanup'], ['projectQueue.js', 'safeAddProject']]) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'queue', f), 'utf8')
  assert(src.includes(fn), `${f} exposes ${fn}`)
  assert(src.includes('isConnectionReady'), `${f} checks dedicated readiness`)
  assert(src.includes('isStreamNotWritableError'), `${f} converts stream error into skip`)
  assert(src.includes('attachDedicatedLogging'), `${f} logs dedicated errors without spam`)
}

// 9. Server boots workers via factories after main READY (not via import side-effect).
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
  assert(src.includes('startDrainQueuedWorker'), 'server boots drain via factory')
  assert(src.includes('startNotifyWorker'), 'server boots notify via factory')
  assert(src.includes('startCleanupWorker'), 'server boots cleanup via factory')
  assert(src.includes('waitForRedis'), 'server still gates boot on main READY')
}

// 10. Drain recovery is resumable (queued, live-run guard) and drains ALL users.
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'queue', 'workers', 'drainQueued.js'), 'utf8')
  assert(src.includes("SET status = 'queued'"), 'drain parks stale projects as queued (not failed)')
  assert(src.includes('isPipelineRunning'), 'drain skips live in-process runs')
  assert(src.includes('SELECT user_id, COUNT(*) as cnt FROM projects WHERE status = \'queued\' GROUP BY user_id'), 'drain lists all queued users')
  assert(!src.match(/await queryOne\(\s*`SELECT user_id, COUNT\(\*\)/), 'drain GROUP BY uses query (not queryOne)')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
