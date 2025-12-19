// bot/src/reminders/worker.ts

import { Job, Worker } from 'bullmq'
import { ReminderStatus, StepVisitSource } from '@prisma/client'
import { redis } from '../redis'
import { prisma } from '../prisma'
import { ReminderJobPayload, REMINDER_QUEUE_NAME, scheduleRemindersForStep, skipAllRemindersForUser } from './scheduler'
import { enterStepForUser } from '../scenario/engine'
import { getTelegramBlockInfo } from '../helpers/telegramBlock'

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
            blockedByUser: true,
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

    // ✅ Если уже blocked — не шлём, помечаем как SKIPPED
    if (subscription.user.blockedByUser) {
      await prisma.reminderSubscription.update({
        where: { id: subscription.id },
        data: {
          status: ReminderStatus.SKIPPED,
          skippedAt: new Date(),
        },
      })
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

      await scheduleRemindersForStep(subscription.userId, subscription.stepId, subscription.scenarioKey ?? 'default')
    } catch (err) {
      // ✅ Если blocked — помечаем user, гасим pending reminders и НЕ кидаем ошибку дальше
      const info = getTelegramBlockInfo(err)
      if (info.isBlocked) {
        await prisma.user.update({
          where: { id: subscription.userId },
          data: {
            blockedByUser: true,
            blockedAt: new Date(),
            blockReason: info.reason ?? 'Blocked',
          },
        })

        // гасим цепочку, чтобы очередь не долбилась дальше
        await skipAllRemindersForUser(subscription.userId)

        return
      }

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
