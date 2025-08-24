import { Job, Queue, Worker } from 'bullmq'
import { redis } from '../redis'
import { FunnelQueuePayload } from '../types/funnel'
import { funnelMessages } from '../config'
import { prisma } from '../prisma'
import { inline_keyboard_generate } from '../helpers/inline_keyboard_generate'
import { bot } from '../telegraf'
import { insertPaymentUrlToButtons } from '../insertPaymentUrlToButtons'
import { FmtString } from 'telegraf/format'

export const funnelQueue = new Queue<FunnelQueuePayload>('funnel', {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 3,
    backoff: { type: 'fixed', delay: 3000 },
  },
})

const funnelWorker = new Worker<FunnelQueuePayload>(
  'funnel',
  async (job: Job<FunnelQueuePayload>) => {
    const { userId, stageIndex } = job.data
    const stage = funnelMessages[stageIndex]
    let nextJobId = null
    if (!stage) {
      throw new Error(`FUNNEL WORKER: Stage not found for index ${stageIndex}`)
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, telegramId: true, paid: true },
    })

    if (user?.paid) {
      return
    }

    if (!user?.telegramId) {
      throw new Error(`FUNNEL WORKER: Telegram User not found for ID ${userId}`)
    }

    if (stage.photoUrl) {
      await bot.telegram.sendPhoto(user.telegramId, stage.photoUrl)
    }

    await insertPaymentUrlToButtons(stage.buttons, user.id)

    await bot.telegram.sendMessage(user.telegramId, new FmtString(stage.text), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: inline_keyboard_generate(stage.buttons),
      },
    })

    const nextStageIndex = stageIndex + 1
    const nextStage = funnelMessages[nextStageIndex]

    if (nextStage && !stage.stop && !user.paid) {
      const nextJob = await funnelQueue.add(
        `funnel-${userId}-${nextStage.id}`,
        {
          userId,
          stageIndex: nextStageIndex,
        },

        {
          delay: process.env.NODE_ENV === 'development' ? 10000 : nextStage.delayMs,
          jobId: `funnel-${userId}-${nextStage.id}`,
        }
      )

      nextJobId = nextJob.id
    }

    await prisma.funnelProgress.update({
      where: { userId },
      data: {
        stageId: stage.id,
        stageIndex: stageIndex + 1,
        nextRunAt: nextStage ? new Date(Date.now() + nextStage.delayMs) : null,
        nextJobId,
        completed: !nextStage,
      },
    })
  },
  {
    concurrency: 100,
    connection: redis,
  }
)

funnelWorker.on('failed', async (job, err) => {
  console.error(`FUNNEL WORKER: Ошибка в задаче ${job?.id}:`, err.message)
})
