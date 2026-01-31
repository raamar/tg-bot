import { Telegraf } from 'telegraf'
import telegrafThrottler from 'telegraf-throttler'
import { Worker, Job } from 'bullmq'
import type { Update } from 'telegraf/typings/core/types/typegram'

import { redis } from '../redis'
import { prisma } from '../prisma'

if (process.env.TELEGRAM_TOKEN_2 === undefined) {
  throw new Error('TELEGRAM_TOKEN_2 is not defined')
}

if (process.env.TELEGRAM_WEBHOOK_URL_2 === undefined) {
  throw new Error('TELEGRAM_WEBHOOK_URL_2 is not defined')
}

export const bot = new Telegraf(process.env.TELEGRAM_TOKEN_2)
const webhookUrl = new URL(process.env.TELEGRAM_WEBHOOK_URL_2)

const throttler = telegrafThrottler({
  out: {
    minTime: 34,
    reservoir: 30,
    reservoirRefreshAmount: 30,
    reservoirRefreshInterval: 1000,
  },
})

bot.use(throttler)

bot.start(async (ctx) => {
  const from: any = ctx.from
  const telegramId = from?.id != null ? String(from.id) : ''

  // просто чтобы проверить db-пакет живой
  if (telegramId) {
    await prisma.user.updateMany({
      where: { telegramId },
      data: { lastInteractionAt: new Date() },
    })
  }

  await ctx.reply('👋 Partner bot живой. /start получен.')
})

bot.on('message', async (ctx) => {
  // минимально: просто отвечаем
  await ctx.reply('✅ Принял сообщение.')
})

const partnerTelegramWorker = new Worker<Update>(
  'telegram_bot2',
  async (job: Job<Update>) => {
    // полезно на старте, чтобы убедиться что прилетает именно сюда
    // eslint-disable-next-line no-console
    await bot.handleUpdate(job.data)
  },
  {
    concurrency: 50,
    connection: redis,
  },
)

partnerTelegramWorker.on('failed', async (job, err) => {
  console.error(`PARTNER TELEGRAM UPDATE: Ошибка в задаче ${job?.id}:`, err.message)
})

bot.launch({
  webhook: {
    domain: webhookUrl.hostname,
    path: webhookUrl.pathname,
  },
})

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
