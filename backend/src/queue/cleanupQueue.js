import { Queue } from 'bullmq'
import { connection } from './connection.js'

export const cleanupQueue = new Queue('cleanup', {
  connection,
  defaultJobOptions: {
    removeOnComplete: { age: 86400, count: 10 },
    removeOnFail: { age: 604800, count: 20 },
  },
})

export default cleanupQueue
