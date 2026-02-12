// bot/src/scenario/types.ts

import type { OfferKey as DbOfferKey } from '@app/db'

export type StepId = string

/**
 * Системные действия, которые обрабатываются не переходом к шагу,
 * а отдельной логикой в коде бота.
 */
export type SystemAction =
  | 'CHECK_SUBSCRIPTION' // проверить подписку и, если ок, перевести дальше
  | 'SHOW_REVIEWS'
  | 'SHOW_CONTENTS'
  | 'EXIT'

export type OfferKey = DbOfferKey

export interface OfferPhase {
  /** Через сколько минут после создания оффера начинается эта фаза */
  startAfterMinutes: number
  price: number
  label?: string
}

export interface OfferTemplate {
  id: OfferKey
  title: string
  currency: 'RUB' | 'USD'
  lifetimeMinutes: number
  phases?: OfferPhase[]
}

/**
 * Кнопки под сообщением
 */
export type ButtonConfig =
  | {
      kind: 'step'
      text: string
      stepId: StepId
    }
  | {
      kind: 'url'
      text: string
      url: string
    }
  | {
      kind: 'system'
      text: string
      action: SystemAction
    }
  | {
      kind: 'offer'
      text: string
      offerKey: OfferKey
    }
  | {
      kind: 'pay_url'
      text: string
      offerKey: OfferKey
    }

export type ButtonRow = ButtonConfig[]

/**
 * Медиа, которые можно прикреплять к шагу сценария.
 *
 * fileIdOrUrl — это либо file_id из Telegram, либо прямой URL.
 */
export interface MediaConfig {
  type: 'photo' | 'video_note' | 'audio' | 'video'
  fileIdOrUrl: string
}

/**
 * Условия, при которых отложенный шаг (reminder) актуален.
 */
export type ReminderCondition = { type: 'notPaid' } | { type: 'notReachedStep'; stepId: StepId }

export interface ReminderBinding {
  /** Какой шаг отправить как напоминание */
  stepId: StepId
  /**
   * Через сколько минут отправить от момента входа в родительский шаг.
   * Если не указано — используем steps[stepId].defaultDelayMinutes.
   */
  delayMinutes?: number
  condition?: ReminderCondition
}

/**
 * Конфиг «время суток», когда можно отправлять шаг.
 *
 * Если указано — шаг / напоминание должен отправляться
 * только в это время суток (по Europe/Moscow),
 * но не раньше, чем пройдёт минимальная задержка (delayMinutes / defaultDelayMinutes).
 */
export interface TimeOfDayConfig {
  hour: number // 0–23
  minute?: number // 0–59, по умолчанию 0
}

/**
 * Базовая сущность — ШАГ сценария.
 */
export interface StepConfig {
  text: string

  systemTitle?: string
  media?: MediaConfig[]

  buttons?: ButtonRow[]

  /**
   * Если шаг используется как напоминание — дефолтное смещение во времени
   * (в минутах) до его отправки.
   */
  defaultDelayMinutes?: number

  /**
   * Какие напоминания (отложенные шаги) повесить при входе в этот шаг.
   */
  reminders?: ReminderBinding[]

  /**
   * Если шаг относится к какой-то офферной логике (например "окно скидки -50%")
   */
  offerKey?: OfferKey

  /**
   * Шаг, который вешается глобально (типа твоих globalReminders)
   */
  isGlobalReminder?: boolean

  /**
   * Если указано — шаг (когда он отправляется как напоминание)
   * будет доставлен только в это время суток (по MOSCOW_TZ),
   * но не раньше, чем истечёт минимальная задержка.
   *
   * Пример:
   *   defaultDelayMinutes = 7 * 60
   *   sendAtTimeOfDay = { hour: 12 }
   *
   * Таймер стартовал в 20:00:
   *   20:00 + 7ч = 03:00 (минимальное время готовности),
   *   ближайшие 12:00 после 03:00 → 12:00 того же дня,
   *   шаг отправится именно тогда.
   */
  sendAtTimeOfDay?: TimeOfDayConfig
}

export interface ScenarioConfig {
  entryStepId: StepId
  steps: Record<StepId, StepConfig>
  globalReminderStepIds?: StepId[]
}
