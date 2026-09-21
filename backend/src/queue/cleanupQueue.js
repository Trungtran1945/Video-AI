import { Queue } from 'bullmq'
import { createRedisConnection, isRedisReady, isConnectionReady, isStreamNotWritableError, attachDedicatedLogging } from './connection.js'

const queueConnection = createRedisConnection()
attachDedicatedLogging(queueConnection, 'CleanupQueue')

export const cleanupQueue = new Queue('cleanup', {
  connection: queueConnection,
  defaultJobOptions: {
    removeOnComplete: { age: 86400, count: 10 },
    removeOnFail: { age: 604800, count: 20 },
  },
})

export function isCleanupQueueReady() {
  return isRedisReady() && isConnectionReady(queueConnection)
}

let warnedDown = false

export async function safeAddCleanup(name, data, opts) {
  if (!isRedisReady() || !isConnectionReady(queueConnection)) {
    if (!warnedDown) {
      warnedDown = true
      console.warn('[CleanupQueue] Redis unavailable — cleanup scheduling skipped')
    }
    return { skipped: true }
  }
  try {
    warnedDown = false
    return await cleanupQueue.add(name, data, opts)
  } catch (err) {
    if (isStreamNotWritableError(err)) {
      console.warn(`[CleanupQueue] Skipped add (stream not writable): ${err.message}`)
      return { skipped: true }
    }
    throw err
  }
}

export default cleanupQueue
