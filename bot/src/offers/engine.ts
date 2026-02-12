// bot/src/offers/engine.ts

import { OfferStatus } from '@app/db'
import { prisma } from '../prisma'
import { offersConfig } from '../scenario/offers'
import { OfferKey } from '../scenario/types'

const IS_PROD = process.env.NODE_ENV === 'production'

/**
 * Считаем, когда истечёт оффер.
 * lifetimeMinutes <= 0 => оффер бессрочный => null.
 * В проде — честные минуты.
 * В dev — 1 час сценария ≈ 1 секунда (для временных офферов).
 */
function computeExpiresAt(now: Date, lifetimeMinutes: number | undefined | null): Date | null {
  if (!lifetimeMinutes || lifetimeMinutes <= 0) {
    return null // бессрочный оффер
  }

  if (IS_PROD) {
    return new Date(now.getTime() + lifetimeMinutes * 60_000)
  }

  const hours = lifetimeMinutes / 60
  const devMs = Math.max(30_000, hours * 1_000) // минимум 30 секунд
  return new Date(now.getTime() + devMs)
}

/**
 * Вернуть последний (по времени создания) инстанс оффера для пользователя.
 * Может быть с любым статусом (ACTIVE/EXPIRED/PAID/…).
 */
export async function getLatestOfferInstance(userId: string, offerKey: OfferKey) {
  return prisma.offerInstance.findFirst({
    where: { userId, offerKey },
    orderBy: { createdAt: 'desc' },
  })
}

/**
 * Гарантировать, что для (userId, offerKey) создан ХОТЯ БЫ ОДИН инстанс оффера.
 *
 * ❗ Важно:
 * - Если уже есть ЛЮБОЙ инстанс (даже EXPIRED/PAID/CANCELED) — просто возвращаем его
 *   и НЕ создаём новый (чтобы нельзя было "перезапустить" предложение).
 * - Если нет ни одного — создаём новый ACTIVE с нужным expiresAt.
 */
export async function ensureOfferInstanceStarted(userId: string, offerKey: OfferKey) {
  const template = offersConfig[offerKey]
  if (!template) {
    throw new Error(`Offer template "${offerKey}" not found`)
  }

  const existing = await getLatestOfferInstance(userId, offerKey)
  if (existing) {
    return existing
  }

  const now = new Date()
  const expiresAt = computeExpiresAt(now, template.lifetimeMinutes)
  const basePrice = template.phases?.[0]?.price ?? 0

  return prisma.offerInstance.create({
    data: {
      userId,
      offerKey,
      status: OfferStatus.ACTIVE,
      createdAt: now,
      expiresAt,
      initialPrice: basePrice,
      currency: template.currency,
    },
  })
}
