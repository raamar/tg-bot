import { InlineKeyboardButton } from 'telegraf/typings/core/types/typegram'
import { InlineButton } from '../types/funnel'

export const inline_keyboard_generate = (buttons: InlineButton[]): InlineKeyboardButton[][] => {
  return [
    buttons.map((button) => {
      const { action, text } = button

      if (action === 'BUY_LINK') {
        const url = `https://${process.env.PUBLIC_DOMAIN}/pay?amount=${button.amount}`
        return { text, url }
      }

      return { text, callback_data: action }
    }),
  ]
}
