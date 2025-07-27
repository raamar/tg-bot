import { Queue } from 'bullmq'
import { redis } from '../redis'

export const cloudpaymentsQueue = new Queue('cloudpayments', {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
  },
})
