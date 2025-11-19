// bot/src/cloudpayments/index.ts

import { Job, Queue, Worker } from 'bullmq'
import { redis } from '../redis'
import { CloudpaymentsQueuePayload } from '../types/funnel'
import { prisma } from '../prisma'
import { confirmPayment } from '../payments/confirmPayment'

export const cloudpaymentsQueue = new Queue<CloudpaymentsQueuePayload>('cloudpayments', {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
  },
})

new Worker<CloudpaymentsQueuePayload>(
  'cloudpayments',
  async (job: Job<CloudpaymentsQueuePayload>) => {
    const { status, invoiceId } = job.data

    try {
      // Для совместимости: считаем, что "Completed" == успешная оплата
      if (status !== 'Completed') {
        console.warn(`Payment worker: получен неожиданный статус "${status}" для платежа ${invoiceId}, job ${job.id}`)
        return
      }

      // Вся бизнес-логика подтверждения оплаты вынесена в confirmPayment
      await confirmPayment(invoiceId)
    } catch (error) {
      console.error(`Payment worker: Ошибка в задаче ${job.id}:`, error)

      // Попробуем пометить платёж как FAILED, если он существует
      try {
        await prisma.payment.update({
          where: { id: invoiceId },
          data: { status: 'FAILED' },
        })
      } catch (updateError) {
        console.error(`Payment worker: не удалось пометить платёж ${invoiceId} как FAILED:`, updateError)
      }

      // Пробрасываем, чтобы BullMQ отразил ошибку
      throw error
    }
  },
  {
    connection: redis,
  }
)
