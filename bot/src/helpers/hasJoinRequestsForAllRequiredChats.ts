// bot/src/helpers/hasJoinRequestsForAllRequiredChats.ts
import type { Telegram } from 'telegraf'
import { prisma } from '../prisma'

const REQUIRED_CHAT_IDS = ['-1002961920513', '-1002951363889']
const OK_STATUSES = ['creator', 'administrator', 'member']

/**
 * true, если по КАЖДОМУ обязательному чату:
 *  - либо юзер уже member/administrator/creator
 *  - либо у него есть join request в этот чат
 */
export const hasJoinRequestsForAllRequiredChats = async (telegram: Telegram, tgUserId: number, userId: string) => {
  for (const chatId of REQUIRED_CHAT_IDS) {
    let ok = false

    // 1) пробуем узнать факт участия через Telegram API
    try {
      const member = await telegram.getChatMember(chatId, tgUserId)

      if (OK_STATUSES.includes(member.status)) {
        ok = true
      }
    } catch (err) {
      // сюда попадём, если бота нет в канале / нет прав / чат приватный и т.п.
      console.error('Ошибка при проверке членства в чате', { chatId, tgUserId, err })
    }

    if (ok) {
      // по этому чату всё хорошо, идём к следующему
      continue
    }

    // 2) если не member (или не смогли проверить), смотрим join request в базе
    const request = await prisma.chatJoinRequest.findUnique({
      where: {
        userId_chatId: {
          userId,
          chatId,
        },
      },
      select: { id: true },
    })

    if (!request) {
      // ни участия, ни заявки — значит не прошёл условие
      return false
    }
  }

  // для всех REQUIRED_CHAT_IDS прошло либо участие, либо заявка
  return true
}
