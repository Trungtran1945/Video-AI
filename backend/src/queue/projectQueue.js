import { Queue } from 'bullmq'
import { createRedisConnection } from './connection.js'

export const projectQueue = new Queue('projects', {
  connection: createRedisConnection(),
  defaultJobOptions: {
    removeOnComplete: { age: 86400, count: 100 },
    removeOnFail: { age: 604800, count: 200 },
  },
})

export default projectQueue
