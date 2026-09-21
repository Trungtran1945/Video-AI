import { Queue } from 'bullmq'
import { createRedisConnection, isRedisReady, isConnectionReady, isStreamNotWritableError, attachDedicatedLogging } from './connection.js'

const queueConnection = createRedisConnection()
attachDedicatedLogging(queueConnection, 'NotifyQueue')

export const notifyQueue = new Queue('notifications', {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 86400, count: 50 },
    removeOnFail: { age: 604800, count: 100 },
  },
})

/** Dedicated-stream readiness (main ready alone is not sufficient). */
export function isNotifyQueueReady() {
  return isRedisReady() && isConnectionReady(queueConnection)
}

let warnedDown = false

/**
 * Queue.add that never corrupts the video pipeline: skips (with a warn)
 * when any Redis stream is down, and converts the ioredis
 * "Stream isn't writeable" rejection into a skip instead of a throw.
 * Returns the BullMQ job, or `{ skipped: true }` when Redis is unavailable.
 */
export async function safeAddNotify(name, data, opts) {
  if (!isRedisReady() || !isConnectionReady(queueConnection)) {
    if (!warnedDown) {
      warnedDown = true
      console.warn('[NotifyQueue] Redis unavailable — notification skipped')
    }
    return { skipped: true }
  }
  try {
    warnedDown = false
    return await notifyQueue.add(name, data, opts)
  } catch (err) {
    if (isStreamNotWritableError(err)) {
      console.warn(`[NotifyQueue] Skipped add (stream not writable): ${err.message}`)
      return { skipped: true }
    }
    throw err
  }
}

export default notifyQueue
