import { Queue } from 'bullmq'
import { connection } from './connection.js'

export const notifyQueue = new Queue('notifications', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 86400, count: 50 },
    removeOnFail: { age: 604800, count: 100 },
  },
})

export default notifyQueue
