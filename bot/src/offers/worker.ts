// bot/src/offers/worker.ts

import { Job, Worker } from 'bullmq'
import { OfferStatus } from '@app/db'
import { redis } from '../redis'
import { prisma } from '../prisma'
import { bot } from '../telegraf'
import { OFFER_EXPIRE_QUEUE_NAME, OfferExpireJobPayload } from './scheduler'

export const offerExpireWorker = new Worker<OfferExpireJobPayload>(
  OFFER_EXPIRE_QUEUE_NAME,
  async (job: Job<OfferExpireJobPayload>) => {
    const { offerInstanceId } = job.data

    const instance = await prisma.offerInstance.findUnique({
      where: { id: offerInstanceId },
    })

    if (!instance) {
      console.warn(`OfferExpireWorker: OfferInstance ${offerInstanceId} not found`)
      return
    }

    // Если уже оплачен или отменён — просто подчистим lastMessage поля
    if (instance.status === OfferStatus.PAID || instance.status === OfferStatus.CANCELED) {
      await prisma.offerInstance.update({
        where: { id: instance.id },
        data: {
          lastMessageBullJobId: null,
        },
      })
      return
    }

    // Если у оффера нет expiresAt — это бессрочный, ничего не делаем
    if (!instance.expiresAt) {
      return
    }

    const now = new Date()
    const expiresAt = new Date(instance.expiresAt)

    // Если ещё не наступило время — просто выходим (теоретически не должно быть)
    if (expiresAt.getTime() > now.getTime()) {
      return
    }

    // Пробуем удалить сообщение, если ID известны
    if (instance.lastMessageChatId && instance.lastMessageId != null) {
      try {
        await bot.telegram.deleteMessage(instance.lastMessageChatId, instance.lastMessageId)
      } catch (err: any) {
        console.error(`OfferExpireWorker: не удалось удалить сообщение оффера ${instance.id}:`, err?.message ?? err)
      }
    }

    // Если до сих пор ACTIVE, помечаем как EXPIRED
    if (instance.status === OfferStatus.ACTIVE) {
      await prisma.offerInstance.update({
        where: { id: instance.id },
        data: {
          status: OfferStatus.EXPIRED,
          finishedAt: now,
          lastMessageBullJobId: null,
        },
      })
    } else {
      await prisma.offerInstance.update({
        where: { id: instance.id },
        data: {
          lastMessageBullJobId: null,
        },
      })
    }
  },
  {
    connection: redis,
    concurrency: 50,
  },
)

offerExpireWorker.on('failed', (job, err) => {
  console.error(`OFFER EXPIRE WORKER: Ошибка в задаче ${job?.id}:`, err?.message ?? err)
})
