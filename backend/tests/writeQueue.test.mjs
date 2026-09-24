import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_write_queue_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const {
  WriteQueueFullError,
  configureWriteQueue,
  getWriteQueueStats,
  withWriteLock,
} = await import('../src/db/query.js')

await initSchema()

let failures = 0
const assert = (condition, message) => {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

const warnings = []
configureWriteQueue({ maxPendingWrites: 1, slowWriteMs: 0, logger: { warn: (message) => warnings.push(message) } })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const first = withWriteLock(async () => sleep(40), { op: 'test.first' })
await sleep(5)
const second = withWriteLock(async () => 'second', { op: 'test.second' })
  .then((value) => ({ status: 'fulfilled', value }))
  .catch((error) => ({ status: 'rejected', error }))
const secondResult = await second
let rejection = null
try {
  await withWriteLock(async () => 'third', { op: 'test.third' })
} catch (error) {
  rejection = error
}
await first
assert(secondResult.status === 'rejected' && secondResult.error instanceof WriteQueueFullError, 'write queue rejects work over the configured bound')
assert(rejection instanceof WriteQueueFullError, 'write queue remains bounded while work is active')
assert(warnings.some((message) => message.includes('op=test.first')), 'slow write warning includes operation name')
assert(!warnings.some((message) => message.includes('secret') || message.includes('token')), 'write telemetry does not include sensitive payloads')

let recovered = null
try {
  await withWriteLock(async () => { throw new Error('queue failure') }, { op: 'test.failure' })
} catch {}
recovered = await withWriteLock(async () => 'alive', { op: 'test.recovered' })
assert(recovered === 'alive', 'write queue continues after an operation failure')
const stats = getWriteQueueStats()
assert(stats.depth === 0 && stats.lastOperation === 'test.recovered', 'queue stats expose depth and last operation')

await fs.promises.rm(process.env.DB_PATH, { force: true })
if (failures > 0) process.exit(1)
console.log('ALL PASS')
