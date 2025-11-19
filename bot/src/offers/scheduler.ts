// bot/src/offers/scheduler.ts

import { Queue } from 'bullmq'
import { OfferInstance } from '@prisma/client'
import { redis } from '../redis'
import { prisma } from '../prisma'

export const OFFER_EXPIRE_QUEUE_NAME = 'offer_expiration'

export interface OfferExpireJobPayload {
  offerInstanceId: string
}

export const offerExpireQueue = new Queue<OfferExpireJobPayload>(OFFER_EXPIRE_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 3,
    backoff: { type: 'fixed', delay: 3000 },
  },
})

/**
 * Спланировать удаление сообщения оффера.
 * Вызываем каждый раз, когда показываем окно оффера.
 * При этом:
 * - Сохраняем chatId/messageId в OfferInstance
 * - Отменяем старую задачу (если была)
 * - Создаём новую задачу на момент expiresAt
 */
export async function scheduleOfferMessageExpiration(
  instance: OfferInstance,
  chatId: number,
  messageId: number
): Promise<void> {
  if (!instance.expiresAt) {
    // бессрочный оффер — ничего не планируем
    return
  }

  const expiresAt = new Date(instance.expiresAt)
  const delayMs = expiresAt.getTime() - Date.now()

  if (delayMs <= 0) {
    // уже истёк — смысла планировать нет
    return
  }

  // отменяем предыдущий джоб, если он ещё есть
  if (instance.lastMessageBullJobId) {
    const oldJob = await offerExpireQueue.getJob(instance.lastMessageBullJobId)
    if (oldJob) {
      await oldJob.remove().catch(() => {})
    }
  }

  const job = await offerExpireQueue.add(
    'offer-expire',
    {
      offerInstanceId: instance.id,
    },
    {
      delay: delayMs,
    }
  )

  await prisma.offerInstance.update({
    where: { id: instance.id },
    data: {
      lastMessageChatId: String(chatId),
      lastMessageId: messageId,
      lastMessageBullJobId: job.id,
    },
  })
}
