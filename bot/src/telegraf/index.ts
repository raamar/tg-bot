import { FmtString } from 'telegraf/format'
import { Worker, Job } from 'bullmq'
import { Update } from 'telegraf/typings/core/types/typegram'
import { Telegraf } from 'telegraf'
import { redis } from '../redis'
import { prisma } from '../prisma'
import { actionsMessages } from '../config'
import { actionHandlers } from './actions'
import { inline_keyboard_generate } from '../helpers/inline_keyboard_generate'
import telegrafThrottler from 'telegraf-throttler'
import { googleSheetQueue } from '../googleSheet'
import { formatDate } from '../helpers/formatDate'
import { adminActions } from './adminActions'
import { DocumentContext, PhotoContext, TextContext } from '../types/admin'

if (process.env.TELEGRAM_TOKEN === undefined) {
  throw new Error('TELEGRAM_TOKEN is not defined')
}

if (process.env.TELEGRAM_WEBHOOK_URL === undefined) {
  throw new Error('TELEGRAM_WEBHOOK_URL is not defined')
}

export const bot = new Telegraf(process.env.TELEGRAM_TOKEN)
const webhookUrl = new URL(process.env.TELEGRAM_WEBHOOK_URL)

const throttler = telegrafThrottler({
  out: {
    minTime: 34,
    reservoir: 30,
    reservoirRefreshAmount: 30,
    reservoirRefreshInterval: 1000,
  },
})

bot.use(throttler)

const telegramWorker = new Worker<Update>(
  'telegram',
  async (job: Job<Update>) => {
    await bot.handleUpdate(job.data)
  },
  {
    concurrency: 10,
    connection: redis,
  }
)

telegramWorker.on('failed', async (job, err) => {
  console.error(`TELEGRAM UPDATE: Ошибка в задаче ${job?.id}:`, err.message)
})

bot.launch({
  webhook: {
    domain: webhookUrl.hostname,
    path: webhookUrl.pathname,
  },
})

for (const [pattern, handler] of Object.entries(adminActions.callbacks)) {
  bot.action(pattern, handler)
}

for (const [action] of Object.entries(actionsMessages)) {
  const customHandler = actionHandlers[action as keyof typeof actionHandlers]

  if (customHandler) {
    bot.action(action, customHandler)
    continue
  }
  bot.action(action, actionHandlers.DEFAULT)
}

bot.start(async (ctx) => {
  const { id, username, first_name, last_name } = ctx.from
  const ref = ctx.message.text?.split(' ')[1] || null
  const { text, buttons, photoUrl } = actionsMessages.START

  const user = await prisma.user.upsert({
    where: { telegramId: String(id) },
    create: {
      telegramId: String(id),
      paid: false,
      username,
      firstName: first_name,
      lastName: last_name,
      refSource: ref || undefined,
    },
    update: {
      username,
      firstName: first_name,
      lastName: last_name,
    },
  })

  if (photoUrl) {
    await ctx.replyWithPhoto(photoUrl)
  }

  await ctx.reply(new FmtString(text), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: inline_keyboard_generate(buttons),
    },
  })

  await googleSheetQueue.add('update', {
    user_telegram_id: user.telegramId,
    user_id: user.id,
    username: user.username ?? undefined,
    first_name: user.firstName ?? undefined,
    last_name: user.lastName ?? undefined,
    ref_code: ref ?? undefined,
    joined_at: formatDate(user.createdAt),
    stage: 'START',
    payment_status: 'NONE',
  })
})

bot.command('broadcast', adminActions.commands.broadcast)
bot.command('export', adminActions.commands.export)

bot.on('message', (ctx, next) => {
  if ('text' in ctx.message) {
    return adminActions.messages.text(ctx as TextContext)
  }
  if ('document' in ctx.message) {
    return adminActions.messages.document(ctx as DocumentContext)
  }
  if ('photo' in ctx.message) {
    return adminActions.messages.photo(ctx as PhotoContext)
  }
  return next()
})

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
