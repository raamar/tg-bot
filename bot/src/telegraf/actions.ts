import { FmtString } from 'telegraf/format'
import { ActionHandlerMap } from '../types/funnel'
import { actionsMessages, defaultExpirationMessage } from '../config'
import { redis } from '../redis'
import { inline_keyboard_generate } from '../helpers/inline_keyboard_generate'

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
      await ctx.reply(defaultExpirationMessage)
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
        inline_keyboard: inline_keyboard_generate(buttons),
      },
    })
  },
}
