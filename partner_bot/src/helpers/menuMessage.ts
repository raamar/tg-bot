import { redis } from '../redis'

type MenuMessage = {
  chatId: number
  messageId: number
}

const menuKey = (telegramId: string) => `partnerbot:menu:${telegramId}`

export const getMenuMessage = async (telegramId: string): Promise<MenuMessage | null> => {
  const raw = await redis.get(menuKey(telegramId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as MenuMessage
  } catch {
    return null
  }
}

export const setMenuMessage = async (telegramId: string, payload: MenuMessage): Promise<void> => {
  await redis.set(menuKey(telegramId), JSON.stringify(payload))
}

export const clearMenuMessage = async (telegramId: string): Promise<void> => {
  await redis.del(menuKey(telegramId))
}
