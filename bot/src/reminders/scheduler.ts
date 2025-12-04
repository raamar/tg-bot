// bot/src/reminders/scheduler.ts

import { Queue } from 'bullmq'
import { ReminderStatus } from '@prisma/client'
import { redis } from '../redis'
import { prisma } from '../prisma'
import { scenario } from '../scenario/config'
import { StepId } from '../scenario/types'
import { computePlannedAtWithTimeOfDay } from '../scenario/time'

export interface ReminderJobPayload {
  reminderSubscriptionId: string
}

export const REMINDER_QUEUE_NAME = 'scenario_reminders'

export const reminderQueue = new Queue<ReminderJobPayload>(REMINDER_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 3,
    backoff: { type: 'fixed', delay: 3000 },
  },
})

const IS_DEV = process.env.NODE_ENV !== 'production'

/**
 * Преобразуем "реальную" задержку (в миллисекундах) в ту, что пойдёт в bull.
 *
 * В проде: используем реальный delayMs.
 * В dev: сильно ускоряем время — как и раньше, через "delayMinutes -> ms".
 */
function toDelayMs(realDelayMs: number, totalDelayMinutes: number): number {
  const baseMs = totalDelayMinutes * 60_000

  if (!IS_DEV) {
    return realDelayMs
  }

  // В dev раньше логика была такая:
  //   delayMinutes -> delayMinutes ms
  // Здесь сохраняем ту же идею: используем суммарные delayMinutes
  // как "ускоренное" время, с минимальным порогом.
  const devMs = Math.max(500, totalDelayMinutes)

  console.log(
    `[REMINDER] dev delay: totalMinutes=${totalDelayMinutes}min (base=${baseMs}ms, realPlanned=${realDelayMs}ms) -> dev=${devMs}ms`
  )

  return devMs
}

/**
 * Навешиваем напоминания для шага.
 *
 * ВАЖНО: reminders внутри одного шага считаем ЦЕПОЧКОЙ:
 * задержка накапливается по порядку (R1, потом R2 после R1 и т.д.).
 *
 * Теперь цепочка считается через "виртуальное время" cursorAt:
 *   - стартуем от момента входа в step,
 *   - для каждого binding:
 *       cursorAt -> +thisDelay -> применяем sendAtTimeOfDay (если есть)
 *       -> получаем scheduledAtReal,
 *       -> cursorAt = scheduledAtReal.
 *
 * А уже потом считаем delay от "сейчас" (nowMs) до scheduledAtReal.
 */
export async function scheduleRemindersForStep(
  userId: string,
  stepId: StepId,
  scenarioKey: string = 'default'
): Promise<void> {
  const step = scenario.steps[stepId]
  if (!step?.reminders || step.reminders.length === 0) return

  const nowMs = Date.now()
  const nowDate = new Date(nowMs)

  // cursorAt — "виртуальное время", от которого считается следующий reminder
  let cursorAt = nowDate

  // Для dev-логики нам всё ещё полезно знать суммарную задержку в минутах,
  // чтобы сохранить прежнее поведение ускорения времени.
  let totalDelayMinutes = 0

  for (const binding of step.reminders) {
    const targetStep = scenario.steps[binding.stepId]
    if (!targetStep) continue

    const thisDelay = binding.delayMinutes ?? targetStep.defaultDelayMinutes
    if (!thisDelay || thisDelay <= 0) continue

    // Для dev-логики накапливаем суммарную задержку
    totalDelayMinutes += thisDelay

    // Считаем "реальное" планируемое время для этого reminder'а:
    // - отталкиваемся от cursorAt,
    // - добавляем thisDelay,
    // - сдвигаемся на ближайшее нужное время суток (если sendAtTimeOfDay задан).
    const scheduledAtReal = computePlannedAtWithTimeOfDay(cursorAt, thisDelay, targetStep.sendAtTimeOfDay)

    // Следующий reminder будет считаться уже от этого момента.
    cursorAt = scheduledAtReal

    // Реальная задержка относительно МОМЕНТА ВХОДА в родительский шаг (nowMs).
    let realDelayMs = scheduledAtReal.getTime() - nowMs
    if (realDelayMs < 0) {
      // На всякий случай: если вдруг получилось в прошлом — ставим минимальную задержку.
      realDelayMs = 500
    }

    const delayMs = toDelayMs(realDelayMs, totalDelayMinutes)
    const scheduledAt = new Date(nowMs + delayMs)

    const subscription = await prisma.reminderSubscription.create({
      data: {
        userId,
        stepId: binding.stepId,
        scenarioKey,
        status: ReminderStatus.PENDING,
        scheduledAt,
      },
    })

    const job = await reminderQueue.add(
      `reminder:${subscription.id}`,
      { reminderSubscriptionId: subscription.id },
      {
        delay: delayMs,
        jobId: `reminder:${subscription.id}`,
      }
    )

    await prisma.reminderSubscription.update({
      where: { id: subscription.id },
      data: { bullJobId: job.id },
    })
  }
}

/**
 * Помечает все будущие напоминания пользователя как SKIPPED
 * и удаляет соответствующие job из Bull.
 */
export async function skipAllRemindersForUser(userId: string): Promise<void> {
  // Находим все напоминания, которые ещё не отправлены
  const reminders = await prisma.reminderSubscription.findMany({
    where: {
      userId,
      status: ReminderStatus.PENDING,
    },
  })

  if (reminders.length === 0) return

  for (const reminder of reminders) {
    try {
      // 1. Удаляем job из очереди Bull
      if (reminder.bullJobId) {
        try {
          await reminderQueue.removeJobScheduler(`reminder:${reminder.id}`)
        } catch (err) {
          console.warn(`Не удалось удалить job ${reminder.id}`, err)
        }
      }

      // 2. Помечаем как SKIPPED
      await prisma.reminderSubscription.update({
        where: { id: reminder.id },
        data: { status: ReminderStatus.SKIPPED },
      })
    } catch (err) {
      console.error(`Ошибка при SKIP напоминания ${reminder.id}`, err)
    }
  }
}
