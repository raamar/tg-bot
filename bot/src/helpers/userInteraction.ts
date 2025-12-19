// bot/src/helpers/userInteraction.ts

import { prisma } from '../prisma'

const TOUCH_DEBOUNCE_MS = 5 * 60 * 1000 // 5 минут

/**
 * Снимаем blockedByUser и фиксируем lastInteractionAt.
 * Чтобы не долбить БД на каждый клик — делаем условие по lastInteractionAt.
 */
export async function touchUserInteractionByTelegramId(telegramId: string): Promise<void> {
  const now = new Date()
  const threshold = new Date(Date.now() - TOUCH_DEBOUNCE_MS)

  await prisma.user.updateMany({
    where: {
      telegramId,
      OR: [{ blockedByUser: true }, { lastInteractionAt: null }, { lastInteractionAt: { lt: threshold } }],
    },
    data: {
      blockedByUser: false,
      blockedAt: null,
      blockReason: null,
      lastInteractionAt: now,
    },
  })
}
