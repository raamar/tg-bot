import { Queue, Worker } from 'bullmq'
import { redis } from '../redis'
import { bot } from '../telegraf'

interface BroadcastJobData {
  adminId: number
  contacts: string[]
  text: string
  photoFileId?: string
}

export const broadcastQueue = new Queue<BroadcastJobData>('broadcast', {
  connection: redis,
})

new Worker<BroadcastJobData>(
  'broadcast',
  async (job) => {
    const { adminId, contacts, text, photoFileId } = job.data

    for (const contactId of contacts) {
      try {
        if (photoFileId) {
          await bot.telegram.sendPhoto(contactId, photoFileId, { caption: text, parse_mode: 'HTML' })
        }
        await bot.telegram.sendMessage(contactId, text, { parse_mode: 'HTML' })
      } catch (error) {
        console.error(`Ошибка при рассылке пользователю ${contactId}:`, error)
      }
    }

    await bot.telegram.sendMessage(adminId, `Рассылка завершена! Отправлено ${contacts.length} сообщений.`)
  },
  {
    connection: redis,
    concurrency: 1,
  }
)
