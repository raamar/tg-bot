import { redis } from '../redis'

type NoticeMessage = {
  chatId: number
  messageId: number
}

const noticeKey = (telegramId: string) => `partnerbot:notice:${telegramId}`

export const getNoticeMessages = async (telegramId: string): Promise<NoticeMessage[]> => {
  const raw = await redis.get(noticeKey(telegramId))
  if (!raw) return []
  try {
    return JSON.parse(raw) as NoticeMessage[]
  } catch {
    return []
  }
}

export const pushNoticeMessage = async (telegramId: string, payload: NoticeMessage): Promise<void> => {
  const existing = await getNoticeMessages(telegramId)
  existing.push(payload)
  await redis.set(noticeKey(telegramId), JSON.stringify(existing))
}

export const clearNoticeMessages = async (telegramId: string): Promise<void> => {
  await redis.del(noticeKey(telegramId))
}
