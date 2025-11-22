import type { Telegram } from 'telegraf' // если нужно для типов, можно и без этого
const REQUIRED_CHAT_IDS = ['-1002961920513', '-1002951363889']

export const isUserSubscribedToAllChats = async (telegram: Telegram, userId: number) => {
  const okStatuses = ['creator', 'administrator', 'member']

  for (const chatId of REQUIRED_CHAT_IDS) {
    try {
      const member = await telegram.getChatMember(chatId, userId)

      // если не в списке нормальных статусов – считаем, что не подписан
      if (!okStatuses.includes(member.status)) {
        return false
      }
    } catch (err) {
      // сюда попадём, если бота нет в канале / у него нет прав / чат приватный без доступа
      console.error('Ошибка при проверке подписки', { chatId, userId, err })
      return false
    }
  }

  // если по всем чатам статус нормальный
  return true
}
