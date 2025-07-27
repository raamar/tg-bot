import { FmtString } from 'telegraf/format'
import { ActionHandlerMap } from '../types/funnel'
import { actionsMessages } from '../config'
import { redis } from '../redis'

export const actionHandlers: ActionHandlerMap = {
  DEFAULT: async (ctx) => {
    let callback_data = 'DEFAULT' as keyof typeof actionsMessages

    if ('data' in ctx.callbackQuery && typeof ctx.callbackQuery.data === 'string') {
      callback_data = ctx.callbackQuery.data as typeof callback_data
    }

    const key = `user:${ctx.from.id}:action:${callback_data}`
    const alreadyDone = await redis.get(key)

    await ctx.answerCbQuery()

    if (alreadyDone) {
      await ctx.reply('Вы уже открыли этот раздел ✅')
      return
    }

    await redis.set(key, '1', 'EX', Number(process.env.TELEGRAM_STEPS_EXPIRE))

    const { text, buttons, photoUrl } = actionsMessages[callback_data]

    if (photoUrl) {
      await ctx.replyWithPhoto(photoUrl)
    }

    await ctx.reply(new FmtString(text), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [buttons.map(({ text, action }) => ({ text, callback_data: action }))],
      },
    })
  },
}
