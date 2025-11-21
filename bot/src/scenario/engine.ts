// bot/src/scenario/engine.ts

import { FmtString } from 'telegraf/format'
import { OfferStatus, StepVisitSource } from '@prisma/client'
import { prisma } from '../prisma'
import { bot } from '../telegraf'
import { scenario } from './config'
import { StepConfig, StepId, ButtonConfig, OfferKey } from './types'
import { offersConfig } from './offers'
import { InlineKeyboardButton, InlineKeyboardMarkup } from 'telegraf/types'
import { ensureOfferInstanceStarted } from '../offers/engine'

const IS_PROD = process.env.NODE_ENV === 'production'
const MOSCOW_TZ = 'Europe/Moscow'

// dev-обёртка текста: префикс с мета-информацией
function withDevMeta(stepId: StepId, text: string): string {
  if (true) return text

  const now = new Date()
  const formatted = now.toLocaleString('ru-RU', {
    timeZone: MOSCOW_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  const meta = `<code>[step=${stepId} @ ${formatted} MSK]</code>\n\n`
  return meta + text
}

function buildInlineKeyboard(step: StepConfig): InlineKeyboardMarkup | undefined {
  if (!step.buttons || step.buttons.length === 0) return undefined

  const inline_keyboard: InlineKeyboardButton[][] = step.buttons.map((row) =>
    row.map((btn: ButtonConfig): InlineKeyboardButton => {
      switch (btn.kind) {
        case 'step':
          return {
            text: btn.text,
            callback_data: `SCN:STEP:${btn.stepId}`,
          }
        case 'system':
          return {
            text: btn.text,
            callback_data: `SCN:SYSTEM:${btn.action}`,
          }
        case 'offer':
          return {
            text: btn.text,
            callback_data: `SCN:OFFER:${btn.offerKey}`,
          }
        case 'url':
          // тут url обязательный, поэтому ок
          return {
            text: btn.text,
            url: btn.url,
          }
      }
    })
  )

  return { inline_keyboard }
}

/**
 * Отправить шаг конкретному пользователю (по userId).
 */
export async function enterStepForUser(userId: string, stepId: StepId, source: StepVisitSource): Promise<StepConfig> {
  const step = scenario.steps[stepId]
  if (!step) {
    throw new Error(`Scenario: step "${stepId}" not found`)
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, telegramId: true },
  })

  if (!user?.telegramId) {
    throw new Error(`Scenario: user "${userId}" not found or has no telegramId`)
  }

  await prisma.user.update({
    where: { id: userId },
    data: { currentStepId: stepId },
  })

  await prisma.stepVisit.create({
    data: {
      userId,
      stepId,
      source,
    },
  })

  /**
   * Если шаг относится к офферной логике, то в момент ПЕРВОГО
   * показа такого шага создаём персональный OfferInstance.
   *
   * Повторные заходы на этот и другие шаги с тем же offerKey
   * НЕ создают новые инстансы — таймер не сбрасывается.
   */
  if (step.offerKey) {
    await ensureOfferInstanceStarted(user.id, step.offerKey)
  }

  // Отправка медиаконтента шага
  if (step.media && step.media.length > 0) {
    for (const media of step.media) {
      if (media.type === 'photo') {
        await bot.telegram.sendPhoto(user.telegramId, media.fileIdOrUrl, {})
      } else if (media.type === 'video_note') {
        await bot.telegram.sendVideoNote(user.telegramId, media.fileIdOrUrl)
      } else if (media.type === 'audio') {
        await bot.telegram.sendAudio(user.telegramId, media.fileIdOrUrl)
      } else if (media.type === 'video') {
        await bot.telegram.sendVideo(user.telegramId, media.fileIdOrUrl)
      }
    }
  }

  const keyboard = buildInlineKeyboard(step)

  const finalText = withDevMeta(stepId, step.text)

  await bot.telegram.sendMessage(user.telegramId, new FmtString(finalText), {
    parse_mode: 'HTML',
    reply_markup: keyboard,
    link_preview_options: {
      is_disabled: true,
    },
  })

  return step
}

export async function createOrUpdateActiveOfferInstance(userId: string, offerKey: OfferKey) {
  const template = offersConfig[offerKey]
  if (!template) {
    throw new Error(`Offer template "${offerKey}" not found`)
  }

  const now = new Date()
  const lifetimeMs = template.lifetimeMinutes * 60_000
  const expiresAt = new Date(now.getTime() + lifetimeMs)

  const basePrice = template.phases?.[0]?.price ?? 0

  // ищем активный оффер этого типа для пользователя
  const existing = await prisma.offerInstance.findFirst({
    where: {
      userId,
      offerKey,
      status: OfferStatus.ACTIVE,
    },
  })

  if (existing) {
    // обновляем срок жизни и цену (если надо)
    return prisma.offerInstance.update({
      where: { id: existing.id },
      data: {
        expiresAt,
        initialPrice: basePrice,
        currency: template.currency,
      },
    })
  }

  // создаём новый
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

/**
 * Хелпер: найти пользователя по Telegram ID и отправить ему шаг.
 */
export async function enterStepByTelegramId(
  telegramId: string,
  stepId: StepId,
  source: StepVisitSource
): Promise<StepConfig | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
  })

  if (!user) return null

  return enterStepForUser(user.id, stepId, source)
}
