import { Job, Queue, Worker } from 'bullmq'
import { redis } from '../redis'
import { CloudpaymentsQueuePayload } from '../types/funnel'
import { prisma } from '../prisma'
import { funnelQueue } from '../funnel'
import { bot } from '../telegraf'
import { getAdmins } from '../helpers/getAdmins'
import { FmtString } from 'telegraf/format'
import { inline_keyboard_generate } from '../helpers/inline_keyboard_generate'
import { actionsMessages } from '../config'

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
          user: {
            update: {
              paid: true,
            },
          },
        },
        select: {
          createdAt: true,
          amount: true,
          url: true,
          paidAt: true,
          user: {
            select: {
              id: true,
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

      const { text, buttons } = actionsMessages.AGREE

      const results = await Promise.allSettled([
        bot.telegram.sendMessage(payments.user.telegramId, new FmtString(text), {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: inline_keyboard_generate(buttons),
          },
        }),
        ...getAdmins().map((adminId) =>
          bot.telegram.sendMessage(adminId, `🦶 Купили гайд!\n` + `💰 Сумма: ${payments.amount.toFixed(2)} ₽`, {
            parse_mode: 'HTML',
          })
        ),
      ])

      results
        .filter((result) => result.status === 'rejected')
        .forEach((rejected) => {
          console.warn('⚠️  Payment: ')
          console.warn(JSON.stringify(rejected, null, 2))
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

      const payments = await prisma.payment.update({
        where: { id: job.data.invoiceId },
        data: {
          status: 'FAILED',
        },
        select: {
          user: { select: { id: true, telegramId: true } },
        },
      })
      throw error
    }
  },
  {
    connection: redis,
  }
)
