import { Queue, Worker, Job } from 'bullmq'
import { redis } from '../redis'
import { bot } from '../telegraf'

interface BroadcastJobData {
  adminId: number
  contacts: string[]
  text: string
  photoFileId?: string
}

interface BroadcastItemJobData {
  adminId: number
  contactId: string
  text: string
  photoFileId?: string
  total: number
  parentJobId: string
}

export const broadcastQueue = new Queue<BroadcastJobData>('broadcast', { connection: redis })
const broadcastItemsQueue = new Queue<BroadcastItemJobData>('broadcast_items', { connection: redis })

new Worker(
  'broadcast',
  async (job) => {
    const { adminId, contacts, text, photoFileId } = job.data
    const parentJobId = job.id!
    const total = contacts.length
    const statusKey = `broadcast_status:${parentJobId}`

    await redis.hmset(statusKey, {
      success: 0,
      failed: 0,
      total,
      adminId,
    })

    for (const contactId of contacts) {
      await broadcastItemsQueue.add(
        'send_message',
        {
          adminId,
          contactId,
          text,
          photoFileId,
          total,
          parentJobId,
        },
        {
          attempts: 3,
          backoff: { type: 'fixed', delay: 1000 },
          removeOnComplete: true,
          removeOnFail: true,
        }
      )
    }
  },
  { connection: redis }
)

const broadcastItemsWorker = new Worker(
  'broadcast_items',
  async (job: Job<BroadcastItemJobData>) => {
    const { contactId, text, photoFileId } = job.data

    if (photoFileId) {
      await bot.telegram.sendPhoto(contactId, photoFileId)
    }
    await bot.telegram.sendMessage(contactId, text, { parse_mode: 'HTML' })
  },
  { connection: redis, concurrency: 20 }
)

async function checkIfDone(parentJobId: string) {
  const statusKey = `broadcast_status:${parentJobId}`
  const status = await redis.hgetall(statusKey)
  const success = Number(status.success)
  const failed = Number(status.failed)
  const total = Number(status.total)
  const adminId = Number(status.adminId)

  if (success + failed === total) {
    await bot.telegram.sendMessage(adminId, `📢 Рассылка завершена!\n✅ Успешно: ${success}\n❌ Ошибок: ${failed}`)
    await redis.del(statusKey)
  }
}

broadcastItemsWorker.on('completed', async (job) => {
  if (!job) return

  const { parentJobId } = job.data
  await redis.hincrby(`broadcast_status:${parentJobId}`, 'success', 1)
  await checkIfDone(parentJobId)
})

broadcastItemsWorker.on('failed', async (job, err) => {
  if (!job) return

  const { parentJobId } = job.data
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await redis.hincrby(`broadcast_status:${parentJobId}`, 'failed', 1)
    await checkIfDone(parentJobId)
  }
})
