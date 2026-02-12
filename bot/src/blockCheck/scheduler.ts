// bot/src/blockCheck/scheduler.ts

import { Queue } from 'bullmq'
import { redis } from '../redis'

export type BlockCheckMode = 'near' | 'all'

export type BlockCheckJobPayload = {
  mode: BlockCheckMode
  horizonHours?: number // для mode=near
  // для прогресса админ-команды
  sessionKey?: string
  adminChatId?: number
  adminMessageId?: number
}

export const BLOCK_CHECK_QUEUE_NAME = 'user_block_check'

export const blockCheckQueue = new Queue<BlockCheckJobPayload>(BLOCK_CHECK_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 1,
  },
})

export async function initBlockCheckScheduler(): Promise<void> {
  // BullMQ RepeatOptions: используем pattern (cron string), а не cron.
  // QueueScheduler в BullMQ 2+ не нужен.
  await blockCheckQueue.add(
    'dailyNear',
    { mode: 'near', horizonHours: 48 },
    {
      jobId: 'blockcheck:daily:near',
      repeat: {
        pattern: '0 3 * * *',
        tz: 'Europe/Moscow',
      },
    }
  )
}
