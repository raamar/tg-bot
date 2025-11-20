// bot/src/scenario/engine.ts

import { FmtString } from 'telegraf/format'
import { OfferStatus, StepVisitSource } from '@prisma/client'
import { prisma } from '../prisma'
import { bot } from '../telegraf'
import { scenario } from './config'
import { StepConfig, StepId, ButtonConfig, OfferKey } from './types'
import { offersConfig } from './offers'
import {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  InputMediaAudio,
  InputMediaDocument,
  InputMediaPhoto,
  InputMediaVideo,
} from 'telegraf/types'
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

  const keyboard = buildInlineKeyboard(step)
  const finalText = withDevMeta(stepId, step.text)

  if (step.media && step.media.length > 0) {
    const album: (InputMediaPhoto | InputMediaVideo | InputMediaAudio | InputMediaDocument)[] = []

    // сначала вынесем media, которые можно отправить группой
    const groupable = step.media.filter((m: any) => ['photo', 'video', 'audio', 'document'].includes(m.type))

    const videoNotes = step.media.filter((m: any) => m.type === 'video_note')

    groupable.forEach((media: any, index: number) => {
      const common: any =
        index === 0
          ? {
              caption: finalText,
              parse_mode: 'HTML',
            }
          : {}

      if (media.type === 'photo') {
        album.push({
          type: 'photo',
          media: media.fileIdOrUrl,
          ...common,
        } as InputMediaPhoto)
      } else if (media.type === 'video') {
        album.push({
          type: 'video',
          media: media.fileIdOrUrl,
          ...common,
        } as InputMediaVideo)
      } else if (media.type === 'audio') {
        album.push({
          type: 'audio',
          media: media.fileIdOrUrl,
          ...common,
        } as InputMediaAudio)
      } else if (media.type === 'document') {
        album.push({
          type: 'document',
          media: media.fileIdOrUrl,
          ...common,
        } as InputMediaDocument)
      }
    })

    // отправляем альбом, если есть что отправлять
    if (album.length > 0) {
      await bot.telegram.sendMediaGroup(user.telegramId, album as any)
    }

    // отдельно отправляем video_note, т.к. они не входят в sendMediaGroup
    for (const media of videoNotes) {
      await bot.telegram.sendVideoNote(user.telegramId, media.fileIdOrUrl)
    }

    // если нужны кнопки – можно отправить отдельным сообщением БЕЗ текста/превью
    if (keyboard && (keyboard as any).inline_keyboard?.length) {
      await bot.telegram.sendMessage(user.telegramId, ' ', {
        reply_markup: keyboard,
        link_preview_options: {
          is_disabled: true,
        },
      })
    }

    // на этом всё, отдельный текстовый месседж с finalText уже не нужен
    return step
  }

  // ===== если медиа нет – старое поведение =====

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
