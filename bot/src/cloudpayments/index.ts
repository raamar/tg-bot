import { Job, Queue, Worker } from 'bullmq'
import { redis } from '../redis'
import { CloudpaymentsQueuePayload } from '../types/funnel'
import { prisma } from '../prisma'
import { funnelQueue } from '../funnel'
import { bot } from '../telegraf'
import { happyEnd } from '../config'

export const cloudpaymentsQueue = new Queue('cloudpayments', {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
  },
})

new Worker<CloudpaymentsQueuePayload>(
  'cloudpayments',
  async (job: Job<CloudpaymentsQueuePayload>) => {
    try {
      if (job.data.status !== 'Completed') {
        throw new Error('Payment: Пришел неожиданный статус')
      }

      const payments = await prisma.payment.update({
        where: { id: job.data.invoiceId },
        data: {
          status: 'PAID',
          paidAt: new Date(),
        },
        select: {
          user: {
            select: {
              telegramId: true,
              funnelProgress: {
                select: {
                  nextJobId: true,
                },
              },
            },
          },
        },
      })

      await bot.telegram.sendMessage(payments.user.telegramId, happyEnd.text, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: happyEnd.button_text, url: happyEnd.url }]],
        },
      })

      const funnelJobIdToCancel = payments.user.funnelProgress?.nextJobId

      if (!funnelJobIdToCancel) {
        return
      }

      const funnelJob = await funnelQueue.getJob(funnelJobIdToCancel)

      if (!funnelJob) {
        return
      }

      await funnelJob.remove()
    } catch (error) {
      console.error(`Payment: Ошибка в задаче ${job.id}:`, error)
      await prisma.payment.update({
        where: { id: job.data.invoiceId },
        data: {
          status: 'FAILED',
        },
      })
      throw error
    }
  },
  {
    connection: redis,
  }
)
