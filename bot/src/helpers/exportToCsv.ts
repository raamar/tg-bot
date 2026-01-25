// bot/src/helpers/exportToCsv.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import { once } from 'events'
import type { Prisma, PrismaClient } from '@app/db'
import { PaymentStatus } from '@app/db'
import { formatDate } from './formatDate'
import { scenario } from '../scenario/config'

type ExportUsersCsvOptions = {
  prisma: PrismaClient
  batchSize?: number
}

const CSV_DELIMITER = ';'
const UTF8_BOM = '\ufeff'

const csvEscape = (value: unknown): string => {
  const s = value == null ? '' : String(value)
  if (s.includes('"') || s.includes('\n') || s.includes('\r') || s.includes(CSV_DELIMITER)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

const writeChunk = async (stream: fs.WriteStream, chunk: string): Promise<void> => {
  if (!stream.write(chunk)) {
    await once(stream, 'drain')
  }
}

type UserRow = Prisma.UserGetPayload<{
  select: {
    id: true
    telegramId: true
    username: true
    firstName: true
    lastName: true
    createdAt: true
    refSource: true
    currentStepId: true
    agreed: true
    blockedByUser: true
    blockedAt: true
    lastInteractionAt: true
    blockReason: true
  }
}>

type PaidPaymentRow = Prisma.PaymentGetPayload<{
  select: { userId: true; amount: true; paidAt: true; createdAt: true }
}>

type PendingPaymentRow = Prisma.PaymentGetPayload<{
  select: { userId: true; url: true; createdAt: true }
}>

export const exportUsersCsvToTempFile = async (
  opts: ExportUsersCsvOptions,
): Promise<{ filePath: string; filename: string; rows: number }> => {
  const prisma = opts.prisma
  const batchSize = opts.batchSize ?? 2000

  const today = new Date().toISOString().slice(0, 10)
  const filename = `users_export_${today}.csv`
  const filePath = path.join(os.tmpdir(), `users_export_${today}_${Date.now()}.csv`)

  const out = fs.createWriteStream(filePath, { encoding: 'utf8' })
  let rows = 0

  try {
    const headers = [
      'user_id',
      'username',
      'Имя',
      'Фамилия',
      'Дата регистрации',
      'Время регистрации',
      'ref',
      'ID Стадии',
      'Сумма',
      'Cсылка для оплаты',
      'Дата оплаты',
      'Время оплаты',
      'Согласие',
      // ✅ new
      'blockedByUser',
      'blockedDate',
      'blockedTime',
      'lastInteractionDate',
      'lastInteractionTime',
      'blockReason',
    ]

    await writeChunk(out, UTF8_BOM + headers.map(csvEscape).join(CSV_DELIMITER) + '\n')

    let cursorId: UserRow['id'] | null = null

    while (true) {
      const users: UserRow[] = await prisma.user.findMany({
        select: {
          id: true,
          telegramId: true,
          username: true,
          firstName: true,
          lastName: true,
          createdAt: true,
          refSource: true,
          currentStepId: true,
          agreed: true,
          blockedByUser: true,
          blockedAt: true,
          lastInteractionAt: true,
          blockReason: true,
        },
        orderBy: { createdAt: 'asc' },
        take: batchSize,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      })

      if (users.length === 0) break

      const userIds: UserRow['id'][] = users.map((u) => u.id)

      const paidPayments: PaidPaymentRow[] = await prisma.payment.findMany({
        where: { userId: { in: userIds }, status: PaymentStatus.PAID },
        select: { userId: true, amount: true, paidAt: true, createdAt: true },
        orderBy: [{ userId: 'asc' }, { paidAt: 'desc' }, { createdAt: 'desc' }],
      })

      const lastPaidByUserId = new Map<UserRow['id'], { amount: unknown; paidAt: Date | null }>()
      for (const p of paidPayments) {
        if (!lastPaidByUserId.has(p.userId)) lastPaidByUserId.set(p.userId, { amount: p.amount, paidAt: p.paidAt })
      }

      const pendingPayments: PendingPaymentRow[] = await prisma.payment.findMany({
        where: { userId: { in: userIds }, status: PaymentStatus.PENDING },
        select: { userId: true, url: true, createdAt: true },
        orderBy: [{ userId: 'asc' }, { createdAt: 'desc' }],
      })

      const lastPendingByUserId = new Map<UserRow['id'], { url: string | null }>()
      for (const p of pendingPayments) {
        if (!lastPendingByUserId.has(p.userId)) lastPendingByUserId.set(p.userId, { url: p.url })
      }

      for (const user of users) {
        const createdParts = formatDate(user.createdAt).split(' ')
        const stageTitle =
          (user.currentStepId && scenario.steps[user.currentStepId]?.systemTitle) || user.currentStepId || ''

        const paid = lastPaidByUserId.get(user.id)
        const paidDate = paid?.paidAt ? formatDate(paid.paidAt).split(' ')[0] : ''
        const paidTime = paid?.paidAt ? formatDate(paid.paidAt).split(' ')[1] : ''

        const pending = lastPendingByUserId.get(user.id)

        const blockedParts = user.blockedAt ? formatDate(user.blockedAt).split(' ') : ['', '']
        const lastIntParts = user.lastInteractionAt ? formatDate(user.lastInteractionAt).split(' ') : ['', '']

        const line = [
          user.telegramId,
          user.username || '',
          user.firstName || '',
          user.lastName || '',
          createdParts[0] ?? '',
          createdParts[1] ?? '',
          user.refSource || '',
          stageTitle,
          paid?.amount != null ? String(paid.amount) : '',
          pending?.url || '',
          paidDate,
          paidTime,
          user.agreed ? 'Да' : 'Нет',
          // ✅ new
          user.blockedByUser ? 'Да' : 'Нет',
          blockedParts[0] ?? '',
          blockedParts[1] ?? '',
          lastIntParts[0] ?? '',
          lastIntParts[1] ?? '',
          user.blockReason ?? '',
        ]
          .map(csvEscape)
          .join(CSV_DELIMITER)

        await writeChunk(out, line + '\n')
        rows += 1
      }

      cursorId = users[users.length - 1].id
    }

    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve())
      out.on('error', reject)
    })

    return { filePath, filename, rows }
  } catch (e) {
    try {
      out.destroy()
    } catch {}
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    } catch {}
    throw e
  }
}
