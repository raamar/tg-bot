import { Queue } from 'bullmq'
import { redis } from '../redis'

export const telegramQueue = new Queue('telegram', { connection: redis })
