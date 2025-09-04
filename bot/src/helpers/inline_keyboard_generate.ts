import { InlineKeyboardButton } from 'telegraf/typings/core/types/typegram'
import { InlineButton } from '../types/funnel'

export const inline_keyboard_generate = (buttons: InlineButton[]): InlineKeyboardButton[][] => {
  return buttons.map((button) => {
    const { action, text } = button

    if (action === 'BUY_LINK' || action === 'LINK') {
      const url = button?.url ?? ''

      if (!url) {
        throw new Error('Отсутствует ссылка')
      }
      return [{ text, url }]
    }

    return [{ text, callback_data: action }]
  })
}
