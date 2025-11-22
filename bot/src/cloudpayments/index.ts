// bot/src/cloudpayments/index.ts

import { Job, Queue, Worker } from 'bullmq'
import { redis } from '../redis'
import { CloudpaymentsQueuePayload } from '../types/funnel'
import { prisma } from '../prisma'
import { confirmPayment } from '../payments/confirmPayment'
import { PaymentStatus } from '@prisma/client'

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

      // ---- ПРОВЕРКА НА ДУБЛИКАТ ----
      // Если платёж уже в статусе PAID — считаем вебхук/таску дубликатом и ничего не делаем.
      const existingPayment = await prisma.payment.findUnique({
        where: { id: invoiceId },
        select: {
          status: true,
          paidAt: true,
        },
      })

      if (existingPayment && existingPayment.status === PaymentStatus.PAID) {
        console.log(
          `Payment worker: дубликат успешной оплаты для платежа ${invoiceId}, job ${
            job.id
          }, уже PAID с paidAt=${existingPayment.paidAt?.toISOString()}`
        )
        return
      }

      if (existingPayment) {
        console.log(
          `Payment worker: найден существующий платёж ${invoiceId} со статусом ${existingPayment.status}, job ${job.id} — продолжаем confirmPayment`
        )
      } else {
        console.log(
          `Payment worker: платёж ${invoiceId} не найден в БД перед confirmPayment, job ${job.id} — confirmPayment должен обработать ситуацию`
        )
      }
      // ---- КОНЕЦ ПРОВЕРКИ НА ДУБЛИКАТА ----

      // Вся бизнес-логика подтверждения оплаты вынесена в confirmPayment
      await confirmPayment(invoiceId)
    } catch (error) {
      console.error(`Payment worker: Ошибка в задаче ${job.id} для платежа ${invoiceId}:`, error)

      // Попробуем пометить платёж как FAILED, но только если он ещё не PAID
      try {
        const payment = await prisma.payment.findUnique({
          where: { id: invoiceId },
          select: { status: true },
        })

        if (!payment) {
          console.error(`Payment worker: не удалось пометить платёж ${invoiceId} как FAILED — запись не найдена`)
        } else if (payment.status === PaymentStatus.PAID) {
          console.warn(`Payment worker: платёж ${invoiceId} уже в статусе PAID, НЕ перезаписываем на FAILED`)
        } else {
          await prisma.payment.update({
            where: { id: invoiceId },
            data: { status: PaymentStatus.FAILED },
          })
          console.log(`Payment worker: платёж ${invoiceId} помечен как FAILED после ошибки в job ${job.id}`)
        }
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
