import fs from 'fs'
import os from 'os'
import path from 'path'
import { once } from 'events'
import type { PrismaClient } from '@app/db'
import { Prisma, PartnerWithdrawalStatus } from '@app/db'
import { BASE_EARNING_RATE, formatMoney } from './money'

const CSV_DELIMITER = ';'
const UTF8_BOM = '\ufeff'

const csvEscape = (value: unknown): string => {
  const s = value == null ? '' : String(value)
  if (s.includes('"') || s.includes('\n') || s.includes('\r') || s.includes(CSV_DELIMITER)) {
    return `"${s.replace(/\"/g, '""')}"`
  }
  return s
}

const writeChunk = async (stream: fs.WriteStream, chunk: string): Promise<void> => {
  if (!stream.write(chunk)) {
    await once(stream, 'drain')
  }
}

export const exportPartnerRefsCsvToTempFile = async (
  prisma: PrismaClient,
): Promise<{ filePath: string; filename: string; rows: number }> => {
  const today = new Date().toISOString().slice(0, 10)
  const filename = `partner_refs_${today}.csv`
  const filePath = path.join(os.tmpdir(), `partner_refs_${today}_${Date.now()}.csv`)

  const referrals = await prisma.partnerReferral.findMany({
    include: {
      partner: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  const refCodes = referrals.map((ref) => ref.code)

  const users =
    refCodes.length === 0
      ? []
      : await prisma.user.findMany({
          where: { refSource: { in: refCodes } },
          select: { id: true, refSource: true },
        })

  const countsByRef = new Map<string, number>()
  const userRefById = new Map<string, string>()
  users.forEach((user) => {
    if (!user.refSource) return
    countsByRef.set(user.refSource, (countsByRef.get(user.refSource) ?? 0) + 1)
    userRefById.set(user.id, user.refSource)
  })

  const userIds = users.map((user) => user.id)
  const paymentSums: Array<{ userId: string; _sum: { amount: Prisma.Decimal | null } }> = []

  const chunkSize = 5000
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize)
    const batch = await prisma.payment.groupBy({
      by: ['userId'],
      where: { status: 'PAID', userId: { in: chunk } },
      _sum: { amount: true },
    })
    paymentSums.push(...batch)
  }

  const paidByRef = new Map<string, Prisma.Decimal>()
  paymentSums.forEach((row) => {
    const refSource = userRefById.get(row.userId)
    if (!refSource) return
    const amount = row._sum.amount ?? new Prisma.Decimal(0)
    const current = paidByRef.get(refSource) ?? new Prisma.Decimal(0)
    paidByRef.set(refSource, current.add(amount))
  })

  const withdrawals = await prisma.partnerWithdrawal.groupBy({
    by: ['partnerId', 'status'],
    _sum: { amount: true },
  })

  const partnerPaidOut = new Map<string, Prisma.Decimal>()
  const partnerPending = new Map<string, Prisma.Decimal>()

  withdrawals.forEach((row) => {
    const amount = row._sum.amount ?? new Prisma.Decimal(0)
    if (row.status === PartnerWithdrawalStatus.APPROVED) {
      partnerPaidOut.set(row.partnerId, amount)
    }
    if (row.status === PartnerWithdrawalStatus.IN_REVIEW) {
      partnerPending.set(row.partnerId, amount)
    }
  })

  const partnerEarnings = new Map<string, Prisma.Decimal>()
  referrals.forEach((ref) => {
    const totalPaid = paidByRef.get(ref.code) ?? new Prisma.Decimal(0)
    const rate = ref.earningRate ?? BASE_EARNING_RATE
    const earnings = totalPaid.mul(rate)
    const current = partnerEarnings.get(ref.partnerId) ?? new Prisma.Decimal(0)
    partnerEarnings.set(ref.partnerId, current.add(earnings))
  })

  const out = fs.createWriteStream(filePath, { encoding: 'utf8' })
  let rows = 0

  try {
    const headers = [
      'ID партнёра',
      'Telegram ID партнёра',
      'Username партнёра',
      'Реф-код',
      'Название рефки',
      'Ставка рефки (%)',
      'Уникальные пользователи',
      'Сумма оплат',
      'Заработок партнёра',
      'Выплачено партнёру',
      'В ожидании выплаты',
      'Доступно к выводу',
    ]

    await writeChunk(out, UTF8_BOM + headers.map(csvEscape).join(CSV_DELIMITER) + '\n')

    for (const ref of referrals) {
      const totalPaid = paidByRef.get(ref.code) ?? new Prisma.Decimal(0)
      const rate = ref.earningRate ?? BASE_EARNING_RATE
      const earnings = totalPaid.mul(rate)

      const paidOut = partnerPaidOut.get(ref.partnerId) ?? new Prisma.Decimal(0)
      const pending = partnerPending.get(ref.partnerId) ?? new Prisma.Decimal(0)
      const totalPartnerEarnings = partnerEarnings.get(ref.partnerId) ?? new Prisma.Decimal(0)
      const available = totalPartnerEarnings.sub(paidOut).sub(pending)

      const ratePercent = formatMoney(rate.mul(100))
      const row = [
        ref.partnerId,
        ref.partner.telegramId,
        ref.partner.username || '',
        ref.code,
        ref.name || ref.code,
        ratePercent,
        countsByRef.get(ref.code) ?? 0,
        formatMoney(totalPaid),
        formatMoney(earnings),
        formatMoney(paidOut),
        formatMoney(pending),
        formatMoney(available),
      ]

      await writeChunk(out, row.map(csvEscape).join(CSV_DELIMITER) + '\n')
      rows += 1
    }
  } finally {
    out.end()
  }

  return { filePath, filename, rows }
}
