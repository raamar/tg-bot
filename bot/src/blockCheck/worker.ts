// bot/src/blockCheck/worker.ts

import { Worker, Job } from 'bullmq'
import { Telegram } from 'telegraf'
import { prisma } from '../prisma'
import { redis } from '../redis'
import { ReminderStatus } from '@app/db'
import { getTelegramBlockInfo } from '../helpers/telegramBlock'
import { BLOCK_CHECK_QUEUE_NAME, type BlockCheckJobPayload } from './scheduler'

const token = process.env.TELEGRAM_TOKEN
if (!token) throw new Error('TELEGRAM_TOKEN is not defined')

const telegram = new Telegram(token)

const REQUEST_TIMEOUT_MS = Number(process.env.BLOCKCHECK_TG_TIMEOUT_MS ?? '15000') // 15s
const MIN_INTERVAL_MS = Number(process.env.BLOCKCHECK_MIN_INTERVAL_MS ?? '40') // ~25 req/s

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function stopKey(sessionKey: string) {
  return `${sessionKey}:stop`
}
function sessionStateKey(sessionKey: string) {
  return `${sessionKey}:state`
}

function buildProgressText(p: {
  mode: string
  total: number
  processed: number
  blocked: number
  unblocked: number
  startedAtIso: string
  done?: boolean
  stopped?: boolean
}) {
  const left = Math.max(0, p.total - p.processed)
  const statusLine = p.done ? '✅ Завершено' : p.stopped ? '🛑 Остановлено' : '⏳ В процессе'

  return [
    `<b>Проверка блокировок</b>`,
    `Режим: <code>${p.mode}</code>`,
    statusLine,
    ``,
    `Всего: <b>${p.total}</b>`,
    `Обработано: <b>${p.processed}</b>`,
    `Осталось: <b>${left}</b>`,
    ``,
    `Blocked: <b>${p.blocked}</b>`,
    `Unblocked: <b>${p.unblocked}</b>`,
    ``,
    `Старт: <code>${p.startedAtIso}</code>`,
  ].join('\n')
}

async function editProgressMessage(adminChatId: number, adminMessageId: number, text: string, showStopButton: boolean) {
  const reply_markup = showStopButton
    ? { inline_keyboard: [[{ text: '🛑 Остановить', callback_data: 'blockcheck:stop' }]] }
    : { inline_keyboard: [] }

  await telegram.editMessageText(adminChatId, adminMessageId, undefined, text, {
    parse_mode: 'HTML',
    reply_markup,
  })
}

async function pingUser(telegramId: string): Promise<{ ok: true } | { ok: false; blocked: boolean; reason?: string }> {
  try {
    // chat action не создаёт сообщений — идеальный "тихий" пинг
    await telegram.sendChatAction(telegramId, 'typing', { timeout: REQUEST_TIMEOUT_MS } as any)
    return { ok: true }
  } catch (e) {
    const info = getTelegramBlockInfo(e)
    return { ok: false, blocked: info.isBlocked, reason: info.reason }
  }
}

type ShortUser = { id: string; telegramId: string; blockedByUser: boolean }

export const blockCheckWorker = new Worker<BlockCheckJobPayload>(
  BLOCK_CHECK_QUEUE_NAME,
  async (job: Job<BlockCheckJobPayload>) => {
    const mode = job.data.mode
    const horizonHours = job.data.horizonHours ?? 48

    const sessionKey = job.data.sessionKey
    const adminChatId = job.data.adminChatId
    const adminMessageId = job.data.adminMessageId

    const startedAtIso = new Date().toISOString()

    let processed = 0
    let blocked = 0
    let unblocked = 0

    let total = 0
    let nearUserIds: string[] | null = null

    if (mode === 'near') {
      const now = new Date()
      const until = new Date(Date.now() + horizonHours * 60 * 60 * 1000)

      const rows = await prisma.reminderSubscription.findMany({
        where: {
          status: ReminderStatus.PENDING,
          scheduledAt: { gte: now, lte: until },
        },
        select: { userId: true },
        distinct: ['userId'],
      })

      nearUserIds = rows.map((r) => r.userId)
      total = nearUserIds.length
    } else {
      total = await prisma.user.count()
    }

    let lastEditAt = 0
    const maybeEdit = async (done = false, stoppedFlag = false) => {
      if (!sessionKey || !adminChatId || !adminMessageId) return

      const now = Date.now()
      const shouldEdit = done || stoppedFlag || now - lastEditAt >= 2000 || processed % 200 === 0
      if (!shouldEdit) return
      lastEditAt = now

      const state = { mode, total, processed, blocked, unblocked, startedAtIso, done, stopped: stoppedFlag }
      await redis.set(sessionStateKey(sessionKey), JSON.stringify(state))

      const text = buildProgressText(state)
      await editProgressMessage(adminChatId, adminMessageId, text, !done && !stoppedFlag).catch(() => {})
    }

    const shouldStop = async () => {
      if (!sessionKey) return false
      const flag = await redis.get(stopKey(sessionKey))
      return flag === '1'
    }

    await maybeEdit(false, false)

    const BATCH = 500

    if (mode === 'near') {
      const ids = nearUserIds ?? []

      for (let offset = 0; offset < ids.length; offset += BATCH) {
        if (await shouldStop()) {
          await maybeEdit(false, true)
          return
        }

        const chunk = ids.slice(offset, offset + BATCH)

        const users: ShortUser[] = await prisma.user.findMany({
          where: { id: { in: chunk } },
          select: { id: true, telegramId: true, blockedByUser: true },
        })

        for (const u of users) {
          if (await shouldStop()) {
            await maybeEdit(false, true)
            return
          }

          const res = await pingUser(u.telegramId)
          if (res.ok) {
            if (u.blockedByUser) {
              await prisma.user.update({
                where: { id: u.id },
                data: { blockedByUser: false, blockedAt: null, blockReason: null },
              })
              unblocked += 1
            }
          } else if (res.blocked) {
            await prisma.user.update({
              where: { id: u.id },
              data: { blockedByUser: true, blockedAt: new Date(), blockReason: res.reason ?? 'Blocked' },
            })
            blocked += 1
          }

          processed += 1
          await maybeEdit(false, false)
          await sleep(MIN_INTERVAL_MS)
        }
      }
    } else {
      let cursorId: string | null = null

      while (true) {
        if (await shouldStop()) {
          await maybeEdit(false, true)
          return
        }

        const users: ShortUser[] = await prisma.user.findMany({
          select: { id: true, telegramId: true, blockedByUser: true },
          orderBy: { id: 'asc' },
          take: BATCH,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        })

        if (users.length === 0) break

        for (const u of users) {
          if (await shouldStop()) {
            await maybeEdit(false, true)
            return
          }

          const res = await pingUser(u.telegramId)
          if (res.ok) {
            if (u.blockedByUser) {
              await prisma.user.update({
                where: { id: u.id },
                data: { blockedByUser: false, blockedAt: null, blockReason: null },
              })
              unblocked += 1
            }
          } else if (res.blocked) {
            await prisma.user.update({
              where: { id: u.id },
              data: { blockedByUser: true, blockedAt: new Date(), blockReason: res.reason ?? 'Blocked' },
            })
            blocked += 1
          }

          processed += 1
          await maybeEdit(false, false)
          await sleep(MIN_INTERVAL_MS)
        }

        cursorId = users[users.length - 1].id
      }
    }

    await maybeEdit(true, false)

    if (sessionKey) {
      await redis.del(stopKey(sessionKey))
    }
  },
  {
    connection: redis,
    concurrency: 1,
  },
)

blockCheckWorker.on('failed', (job, err) => {
  console.error(`BLOCK CHECK WORKER: Ошибка в задаче ${job?.id}:`, err?.message ?? err)
})
