import { Worker, Job } from 'bullmq'
import { Update } from 'telegraf/typings/core/types/typegram'
import { Telegraf } from 'telegraf'
import { message } from 'telegraf/filters'
import { redis } from '../redis'

if (process.env.TELEGRAM_TOKEN === undefined) {
  throw new Error('TELEGRAM_TOKEN is not defined')
}

if (process.env.TELEGRAM_WEBHOOK_URL === undefined) {
  throw new Error('TELEGRAM_WEBHOOK_URL is not defined')
}

const bot = new Telegraf(process.env.TELEGRAM_TOKEN)
const webhookUrl = new URL(process.env.TELEGRAM_WEBHOOK_URL)

new Worker<Update>(
  'telegram',
  async (job: Job<Update>) => {
    try {
      await bot.handleUpdate(job.data)
    } catch (error) {
      console.error(`TELEGRAM UPDATE: Ошибка в задаче ${job.id}:`, error)
      throw error
    }
  },
  {
    connection: redis,
  }
)

bot.launch({
  webhook: {
    domain: webhookUrl.hostname,
    path: webhookUrl.pathname,
  },
})

bot.on(message('text'), (ctx) => {
  ctx.reply(ctx.message.text)
})
