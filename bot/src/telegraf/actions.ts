import { FmtString } from 'telegraf/format'
import { ActionHandlerMap } from '../types/funnel'
import {
  actionsMessages,
  default401Message,
  default403Message,
  default500Message,
  defaultExpirationMessage,
  funnelMessages,
} from '../config'
import { redis } from '../redis'
import { inline_keyboard_generate } from '../helpers/inline_keyboard_generate'
import { prisma } from '../prisma'
import { funnelQueue } from '../funnel'
import { insertPaymentUrlToButtons } from '../insertPaymentUrlToButtons'

export const actionHandlers: ActionHandlerMap = {
  DEFAULT: async (ctx) => {
    const telegramId = String(ctx.from.id)
    let callback_data = 'DEFAULT' as keyof typeof actionsMessages

    if ('data' in ctx.callbackQuery && typeof ctx.callbackQuery.data === 'string') {
      callback_data = ctx.callbackQuery.data as typeof callback_data
    }

    const key = `user:${ctx.from.id}:action:${callback_data}`
    const alreadyDone = await redis.get(key)

    await ctx.answerCbQuery()

    if (alreadyDone) {
      await ctx.reply(defaultExpirationMessage)
      return false
    }

    const user = await prisma.user.findFirst({ where: { telegramId }, select: { id: true } })

    if (!user) {
      await ctx.reply(default403Message)
      return false
    }

    await redis.set(key, '1', 'EX', Number(process.env.TELEGRAM_STEPS_EXPIRE))

    const { text, buttons, photoUrl, circleUrl } = actionsMessages[callback_data]

    if (photoUrl) {
      await ctx.replyWithPhoto(photoUrl)
    }

    if (circleUrl) {
      await ctx.replyWithVideoNote(circleUrl)
    }

    await insertPaymentUrlToButtons(buttons, user.id)
    await ctx.reply(new FmtString(text), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: inline_keyboard_generate(buttons),
      },
    })

    return true
  },
  START_FUNNEL: async (ctx) => {
    const telegramId = String(ctx.from.id)

    const user = await prisma.user.findFirst({
      where: { telegramId },
      select: { id: true, subscribed: true },
    })

    if (!user) {
      await ctx.reply(default403Message)
      return false
    }

    if (!user.subscribed) {
      await ctx.reply(default401Message)
      return false
    }

    const defaultResult = await actionHandlers.DEFAULT(ctx)

    if (!defaultResult) {
      return false
    }

    const nextJob = await funnelQueue.add(
      `funnel-${user.id}-${funnelMessages[0].id}`,
      {
        userId: user.id,
        stageIndex: 0,
      },
      {
        delay: process.env.NODE_ENV === 'development' ? 60000 : funnelMessages[0].delayMs,
        jobId: `funnel-${user.id}-${funnelMessages[0].id}`,
      }
    )

    await prisma.funnelProgress.upsert({
      where: { userId: user.id },
      update: {
        stageId: 'START_FUNNEL',
        stageIndex: 0,
        nextJobId: nextJob.id,
        startedAt: new Date(),
        nextRunAt: new Date(Date.now() + funnelMessages[0].delayMs),
      },
      create: {
        userId: user.id,
        stageId: funnelMessages[0].id,
        stageIndex: 0,
        nextJobId: nextJob.id,
        startedAt: new Date(),
        nextRunAt: new Date(Date.now() + funnelMessages[0].delayMs),
      },
    })

    return true
  },
  SUBSCRIBE: async (ctx) => {
    const telegramId = String(ctx.from.id)

    const user = await prisma.user.findFirst({
      where: { telegramId },
      select: {
        id: true,
        funnelProgress: {
          select: {
            stageId: true,
          },
        },
      },
    })

    if (!user) {
      await ctx.reply(default403Message)
      return false
    }

    const defaultResult = await actionHandlers.DEFAULT(ctx)

    if (!defaultResult) {
      return false
    }

    return true
  },
  HAPPY_END: async (ctx) => {
    const telegramId = String(ctx.from.id)

    const user = await prisma.user.update({
      where: { telegramId },
      data: { agreed: true },
      select: { id: true, paid: true },
    })

    if (!user) {
      await ctx.reply(default403Message)
      return false
    }

    if (!user.paid) {
      await ctx.reply(default500Message)
      return false
    }

    const defaultResult = await actionHandlers.DEFAULT(ctx)

    if (!defaultResult) {
      return false
    }
    return true
  },
}
