import { Queue } from 'bullmq'
import { createRedisConnection, isRedisReady, isConnectionReady, isStreamNotWritableError, attachDedicatedLogging, getRedisEndpoint } from './connection.js'

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
    console.warn(`[ProjectQueue] Redis unavailable at ${getRedisEndpoint()} — job "${name}" scheduling skipped (project stays queued; draining resumes when Redis ready)`)
    return { skipped: true, reason: 'REDIS_UNAVAILABLE' }
  }
  try {
    return await projectQueue.add(name, data, opts)
  } catch (err) {
    if (isStreamNotWritableError(err)) {
      console.warn(`[ProjectQueue] Skipped add (stream not writable) at ${getRedisEndpoint()}: ${err.message}`)
      return { skipped: true, reason: 'REDIS_UNAVAILABLE' }
    }
    throw err
  }
}

export default projectQueue
