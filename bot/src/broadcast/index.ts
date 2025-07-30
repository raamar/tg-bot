import { Queue, Worker, QueueEvents, Job } from 'bullmq'
import { redis } from '../redis'
import { bot } from '../telegraf'

interface BroadcastJobData {
  adminId: number
  contacts: string[]
  text: string
  photoFileId?: string
}

interface BroadcastItemJobData {
  jobId: string
  adminId: number
  contactId: string
  text: string
  photoFileId?: string
}

export const broadcastQueue = new Queue<BroadcastJobData>('broadcast', {
  connection: redis,
})

export const broadcastItemsQueue = new Queue<BroadcastItemJobData>('broadcast_items', {
  connection: redis,
})

new Worker<BroadcastJobData>(
  'broadcast',
  async (job) => {
    const { adminId, contacts, text, photoFileId } = job.data
    const jobId = job.id!
    const keyBase = `broadcast:${jobId}`

    await redis.mset({
      [`${keyBase}:total`]: contacts.length,
      [`${keyBase}:success`]: 0,
      [`${keyBase}:failed`]: 0,
      [`${keyBase}:adminId`]: adminId,
    })

    for (const contactId of contacts) {
      await broadcastItemsQueue.add('broadcast_item', {
        jobId,
        adminId,
        contactId,
        text,
        photoFileId,
      })
    }

    await bot.telegram.sendMessage(adminId, `📤 Рассылка началась. Всего контактов: ${contacts.length}`)
  },
  {
    connection: redis,
  }
)

new Worker<BroadcastItemJobData>(
  'broadcast_items',
  async (job) => {
    const { contactId, text, photoFileId } = job.data

    try {
      if (photoFileId) {
        await bot.telegram.sendPhoto(contactId, photoFileId)
      }
      await bot.telegram.sendMessage(contactId, text, { parse_mode: 'HTML' })
    } catch (error: any) {
      const code = error?.code
      const message = error?.message
      console.error(`❌ Ошибка при отправке ${contactId}:`, code || message || error)
      throw new Error(code || message || 'unknown error')
    }
  },
  {
    connection: redis,
    concurrency: 20,
  }
)

const broadcastItemsEvents = new QueueEvents('broadcast_items', {
  connection: redis,
})

broadcastItemsEvents.on('completed', async ({ jobId }) => {
  await handleResult('success', jobId!)
})

broadcastItemsEvents.on('failed', async ({ jobId }) => {
  await handleResult('failed', jobId!)
})

async function handleResult(type: 'success' | 'failed', jobId: string) {
  const keyBase = `broadcast:${jobId}`
  const counterKey = type === 'success' ? `${keyBase}:success` : `${keyBase}:failed`
  await redis.incr(counterKey)

  const [successStr, failedStr, totalStr, adminIdStr] = await redis.mget(
    `${keyBase}:success`,
    `${keyBase}:failed`,
    `${keyBase}:total`,
    `${keyBase}:adminId`
  )

  const success = parseInt(successStr || '0', 10)
  const failed = parseInt(failedStr || '0', 10)
  const total = parseInt(totalStr || '0', 10)
  const adminId = parseInt(adminIdStr || '0', 10)

  if (success + failed >= total && total > 0) {
    await bot.telegram.sendMessage(adminId, `✅ Рассылка завершена.\nУспешно: ${success}\nОшибок: ${failed}`)

    await redis.del(`${keyBase}:success`, `${keyBase}:failed`, `${keyBase}:total`, `${keyBase}:adminId`)
  }
}
