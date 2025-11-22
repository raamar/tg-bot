// bot/src/reminders/worker.ts

import { Job, Worker } from 'bullmq'
import { ReminderStatus, StepVisitSource } from '@prisma/client'
import { redis } from '../redis'
import { prisma } from '../prisma'
import { ReminderJobPayload, REMINDER_QUEUE_NAME, scheduleRemindersForStep } from './scheduler'
import { enterStepForUser } from '../scenario/engine'

export const reminderWorker = new Worker<ReminderJobPayload>(
  REMINDER_QUEUE_NAME,
  async (job: Job<ReminderJobPayload>) => {
    const { reminderSubscriptionId } = job.data

    const subscription = await prisma.reminderSubscription.findUnique({
      where: { id: reminderSubscriptionId },
      include: {
        user: {
          select: {
            id: true,
            paid: true,
          },
        },
      },
    })

    if (!subscription) {
      console.warn(`ReminderWorker: subscription ${reminderSubscriptionId} not found`)
      return
    }

    if (subscription.status !== ReminderStatus.PENDING) {
      return
    }

    // Если уже оплатил — не шлём, помечаем как SKIPPED
    if (subscription.user.paid) {
      await prisma.reminderSubscription.update({
        where: { id: subscription.id },
        data: {
          status: ReminderStatus.SKIPPED,
          skippedAt: new Date(),
        },
      })
      return
    }

    try {
      await enterStepForUser(subscription.userId, subscription.stepId, StepVisitSource.REMINDER)

      await prisma.reminderSubscription.update({
        where: { id: subscription.id },
        data: {
          status: ReminderStatus.SENT,
          processedAt: new Date(),
        },
      })

      // навесим цепочку следующих напоминаний, если они описаны у этого шага
      await scheduleRemindersForStep(subscription.userId, subscription.stepId, subscription.scenarioKey ?? 'default')
    } catch (err) {
      console.error(`ReminderWorker: error while processing reminder ${subscription.id}:`, err)
      throw err
    }
  },
  {
    connection: redis,
    concurrency: 100,
  }
)

reminderWorker.on('failed', (job, err) => {
  console.error(`REMINDER WORKER: Ошибка в задаче ${job?.id}:`, err?.message ?? err)
})
