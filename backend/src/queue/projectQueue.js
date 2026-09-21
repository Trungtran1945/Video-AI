import { Queue } from 'bullmq'
import { createRedisConnection, isRedisReady, isConnectionReady, isStreamNotWritableError, attachDedicatedLogging } from './connection.js'

const queueConnection = createRedisConnection()
attachDedicatedLogging(queueConnection, 'ProjectQueue')

export const projectQueue = new Queue('projects', {
  connection: queueConnection,
  defaultJobOptions: {
    removeOnComplete: { age: 86400, count: 100 },
    removeOnFail: { age: 604800, count: 200 },
  },
})

export function isProjectQueueReady() {
  return isRedisReady() && isConnectionReady(queueConnection)
}

export async function safeAddProject(name, data, opts) {
  if (!isRedisReady() || !isConnectionReady(queueConnection)) {
    console.warn('[ProjectQueue] Redis unavailable — job scheduling skipped')
    return { skipped: true }
  }
  try {
    return await projectQueue.add(name, data, opts)
  } catch (err) {
    if (isStreamNotWritableError(err)) {
      console.warn(`[ProjectQueue] Skipped add (stream not writable): ${err.message}`)
      return { skipped: true }
    }
    throw err
  }
}

export default projectQueue
