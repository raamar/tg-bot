import { Queue } from 'bullmq'
import { redis } from '../redis'

const defaultJobOptions = {
  removeOnComplete: true,
  removeOnFail: false,
  attempts: 3,
  backoff: { type: 'fixed', delay: 3000 },
} as const

export const telegramQueue1 = new Queue('telegram_bot1', {
  connection: redis,
  defaultJobOptions,
})

export const telegramQueue2 = new Queue('telegram_bot2', {
  connection: redis,
  defaultJobOptions,
})
