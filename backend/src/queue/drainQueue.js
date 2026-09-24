import { Queue } from 'bullmq'
import { createRedisConnection, isRedisReady, isConnectionReady, isStreamNotWritableError, attachDedicatedLogging } from './connection.js'

const queueConnection = createRedisConnection()
attachDedicatedLogging(queueConnection, 'DrainQueue')

export const drainQueue = new Queue('drain-queued', {
  connection: queueConnection,
  defaultJobOptions: {
    removeOnComplete: { age: 300, count: 10 },
    removeOnFail: { age: 3600, count: 20 },
  },
})

export async function safeAddDrainSweep() {
  if (!isRedisReady() || !isConnectionReady(queueConnection)) return { skipped: true }
  try {
    return await drainQueue.add('sweep', {}, {
      repeat: { every: 5000 },
      removeOnComplete: true,
      removeOnFail: { count: 20 },
    })
  } catch (error) {
    if (isStreamNotWritableError(error)) return { skipped: true }
    throw error
  }
}

queueConnection.on('ready', () => {
  safeAddDrainSweep().catch((error) => {
    if (!isStreamNotWritableError(error)) console.error(`[DrainQueue] scheduling failed: ${error.message}`)
  })
})

export default drainQueue
