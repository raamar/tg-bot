// bot/src/reminders/scheduler.ts

import { Queue } from 'bullmq'
import { ReminderStatus } from '@prisma/client'
import { redis } from '../redis'
import { prisma } from '../prisma'
import { scenario } from '../scenario/config'
import { StepId } from '../scenario/types'

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

function toDelayMs(delayMinutes: number): number {
  const baseMs = delayMinutes * 60_000

  if (!IS_DEV) {
    return baseMs
  }

  const devMs = delayMinutes
  const final = Math.max(500, devMs) // минимум 0.5 секунды

  console.log(`[REMINDER] dev delay: original=${delayMinutes}min (${baseMs}ms) -> dev=${final}ms`)

  return final
}

/**
 * Навешиваем напоминания для шага.
 *
 * ВАЖНО: reminders внутри одного шага считаем ЦЕПОЧКОЙ:
 * задержка накапливается по порядку (R1, потом R2 после R1 и т.д.).
 */
export async function scheduleRemindersForStep(
  userId: string,
  stepId: StepId,
  scenarioKey: string = 'default'
): Promise<void> {
  const step = scenario.steps[stepId]
  if (!step?.reminders || step.reminders.length === 0) return

  const now = Date.now()
  let totalDelayMinutes = 0

  for (const binding of step.reminders) {
    const targetStep = scenario.steps[binding.stepId]
    if (!targetStep) continue

    const thisDelay = binding.delayMinutes ?? targetStep.defaultDelayMinutes

    if (!thisDelay || thisDelay <= 0) continue

    // накапливаем задержку
    totalDelayMinutes += thisDelay

    const delayMs = toDelayMs(totalDelayMinutes)
    const scheduledAt = new Date(now + delayMs)

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
