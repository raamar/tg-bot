// bot/src/scenario/time.ts

import type { TimeOfDayConfig } from './types'

const MOSCOW_TZ = 'Europe/Moscow'

/**
 * Получаем смещение таймзоны (в минутах) для конкретного UTC-времени.
 * Используем Intl.DateTimeFormat с timeZoneName = 'shortOffset'.
 */
function getTimeZoneOffsetMinutes(timeZone: string, dateUtc: Date): number {
  const dtf = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'shortOffset',
  })

  const parts = dtf.formatToParts(dateUtc)
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT+0'

  // Примеры значений: "GMT+3", "GMT+03:00"
  const match = tzName.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/)
  if (!match) return 0

  const hours = parseInt(match[1], 10)
  const minutes = match[2] ? parseInt(match[2], 10) : 0

  return hours * 60 + minutes
}

/**
 * Строим UTC-дату по локальной дате/времени в указанной таймзоне.
 *
 * year, month, day, hour, minute — ЛОКАЛЬНЫЕ значения.
 */
function makeUtcDateFromLocal(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): Date {
  // Сначала создаём дату как будто это UTC-время
  const fakeUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0))

  // Узнаём реальное смещение этой таймзоны для этого момента
  const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, fakeUtc)

  // Локальное время = UTC + offset
  // => UTC = локальное - offset
  return new Date(fakeUtc.getTime() - offsetMinutes * 60_000)
}

/**
 * Основная функция:
 *
 * - берём текущий момент `now` (UTC),
 * - добавляем минимальную задержку `delayMinutes`,
 * - если `sendAtTimeOfDay` НЕ указан — возвращаем этот момент,
 * - если указан — сдвигаем на ближайшее время вида "HH:mm" в MOSCOW_TZ,
 *   которое НЕ раньше этого момента.
 */
export function computePlannedAtWithTimeOfDay(
  now: Date,
  delayMinutes: number,
  sendAtTimeOfDay?: TimeOfDayConfig,
  timeZone: string = MOSCOW_TZ
): Date {
  // Минимальное время, когда шаг "можно" отправлять
  const minReadyAt = new Date(now.getTime() + delayMinutes * 60_000)

  // Если привязка ко времени суток не нужна — работаем как раньше
  if (!sendAtTimeOfDay) {
    return minReadyAt
  }

  const { hour, minute = 0 } = sendAtTimeOfDay

  // Берём локальную дату minReadyAt в нужной таймзоне
  const dtf = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  })

  const parts = dtf.formatToParts(minReadyAt)
  const get = (type: string) => {
    const part = parts.find((p) => p.type === type)
    return parseInt(part?.value ?? '0', 10)
  }

  let year = get('year')
  let month = get('month')
  let day = get('day')

  // Кандидат: "сегодня в HH:mm" по локальному времени таймзоны
  let candidateUtc = makeUtcDateFromLocal(timeZone, year, month, day, hour, minute)

  // Если кандидат раньше минимального времени готовности —
  // двигаем на следующий день, снова считаем "HH:mm"
  if (candidateUtc.getTime() < minReadyAt.getTime()) {
    const nextDayLocal = new Date(Date.UTC(year, month - 1, day) + 24 * 60 * 60_000)
    const partsNext = dtf.formatToParts(nextDayLocal)

    const getNext = (type: string) => {
      const part = partsNext.find((p) => p.type === type)
      return parseInt(part?.value ?? '0', 10)
    }

    year = getNext('year')
    month = getNext('month')
    day = getNext('day')

    candidateUtc = makeUtcDateFromLocal(timeZone, year, month, day, hour, minute)
  }

  return candidateUtc
}
