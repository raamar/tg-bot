import { Queue } from 'bullmq'
import { redis } from '../redis'

export const telegramQueue = new Queue('telegram', {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 3,
    backoff: { type: 'fixed', delay: 3000 },
  },
})
