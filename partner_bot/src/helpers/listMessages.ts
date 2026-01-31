import { redis } from '../redis'

type ListMessage = {
  chatId: number
  messageId: number
}

const listKey = (telegramId: string) => `partnerbot:list:${telegramId}`

export const getListMessages = async (telegramId: string): Promise<ListMessage[]> => {
  const raw = await redis.get(listKey(telegramId))
  if (!raw) return []
  try {
    return JSON.parse(raw) as ListMessage[]
  } catch {
    return []
  }
}

export const pushListMessage = async (telegramId: string, payload: ListMessage): Promise<void> => {
  const existing = await getListMessages(telegramId)
  existing.push(payload)
  await redis.set(listKey(telegramId), JSON.stringify(existing))
}

export const clearListMessages = async (telegramId: string): Promise<void> => {
  await redis.del(listKey(telegramId))
}
