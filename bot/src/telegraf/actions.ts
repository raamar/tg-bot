import { FmtString } from 'telegraf/format'
import { ActionHandlerMap } from '../types/funnel'
import { actionsMessages, default403Message, defaultExpirationMessage, funnelMessages } from '../config'
import { redis } from '../redis'
import { inline_keyboard_generate } from '../helpers/inline_keyboard_generate'
import { prisma } from '../prisma'
import { funnelQueue } from '../funnel'
import { insertPaymentUrlToButtons } from '../insertPaymentUrlToButtons'
import { googleSheetQueue } from '../googleSheet'

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
      return
    }

    const user = await prisma.user.findFirst({ where: { telegramId }, select: { id: true } })

    if (!user) {
      await ctx.reply(default403Message)
      return
    }

    await redis.set(key, '1', 'EX', Number(process.env.TELEGRAM_STEPS_EXPIRE))

    const { text, buttons, photoUrl } = actionsMessages[callback_data]

    if (photoUrl) {
      await ctx.replyWithPhoto(photoUrl)
    }

    await insertPaymentUrlToButtons(buttons, user.id)
    await ctx.reply(new FmtString(text), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: inline_keyboard_generate(buttons),
      },
    })

    buttons
      .filter((button) => button.action === 'BUY_LINK')
      .forEach(({ url, amount }) => {
        googleSheetQueue.add('update', {
          user_id: user.id,
          user_telegram_id: telegramId,
          payment_status: 'PENDING',
          amount: String(amount),
          order_url: url,
        })
      })

    googleSheetQueue.add('update', {
      user_id: user.id,
      user_telegram_id: telegramId,
      stage: callback_data,
    })
  },

  START_FUNNEL: async (ctx) => {
    await actionHandlers.DEFAULT(ctx)

    const telegramId = String(ctx.from.id)

    const user = await prisma.user.upsert({
      where: { telegramId },
      update: {
        updatedAt: new Date(),
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
      },
      create: {
        telegramId,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
      },
    })

    const nextJob = await funnelQueue.add(
      `funnel-${user.id}-${funnelMessages[0].id}`,
      {
        userId: user.id,
        stageIndex: 0,
      },
      { delay: process.env.NODE_ENV === 'development' ? 10000 : funnelMessages[0].delayMs }
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
  },
  SUBSCRIBE: async (ctx) => {
    const telegramId = String(ctx.from.id)

    const user = await prisma.user.upsert({
      where: { telegramId },
      update: {
        updatedAt: new Date(),
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
      },
      create: {
        telegramId,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
      },
      select: {
        id: true,
        funnelProgress: {
          select: {
            stageId: true,
            completed: true,
          },
        },
      },
    })

    const stageIndex = funnelMessages.findIndex((stage) => stage.id === user.funnelProgress!.stageId)
    const stage = funnelMessages[stageIndex]
    const nextStageIndex = stageIndex + 1
    const nextStage = funnelMessages[nextStageIndex]

    if (user.funnelProgress?.completed) {
      await ctx.reply('Вы уже прошли этот этап. Спасибо за участие!')
      return
    }

    if (!user.funnelProgress) {
      console.warn(`User ${user.id} has no funnel progress`)
      return
    }

    await actionHandlers.DEFAULT(ctx)

    const nextJob = await funnelQueue.add(
      `funnel-${user.id}-${nextStage.id}`,
      {
        userId: user.id,
        stageIndex: nextStageIndex,
      },
      { delay: process.env.NODE_ENV === 'development' ? 10000 : nextStage.delayMs }
    )
    await prisma.funnelProgress.update({
      where: { userId: user.id },
      data: {
        stageId: stage.id,
        nextJobId: nextJob.id,
        stageIndex: stageIndex + 1,
        nextRunAt: new Date(Date.now() + nextStage.delayMs),
        completed: false,
      },
    })
  },
}
