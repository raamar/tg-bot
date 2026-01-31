import fs from 'fs'
import os from 'os'
import path from 'path'
import { once } from 'events'
import type { PrismaClient } from '@app/db'
import { Prisma, PartnerWithdrawalStatus } from '@app/db'

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
  const userCounts = await prisma.user.groupBy({
    by: ['refSource'],
    where: { refSource: { in: refCodes } },
    _count: { _all: true },
  })

  const countsByRef = new Map<string, number>()
  userCounts.forEach((row) => {
    if (row.refSource) countsByRef.set(row.refSource, row._count._all)
  })

  const paymentSums =
    refCodes.length === 0
      ? []
      : await prisma.$queryRaw<Array<{ refsource: string; totalpaid: Prisma.Decimal | null }>>`
          SELECT u."refSource" as refsource, SUM(p.amount) as totalpaid
          FROM "Payment" p
          JOIN "User" u ON u.id = p."userId"
          WHERE p.status = 'PAID' AND u."refSource" IN (${Prisma.join(refCodes)})
          GROUP BY u."refSource"
        `

  const paidByRef = new Map<string, Prisma.Decimal>()
  paymentSums.forEach((row) => {
    if (row.refsource) {
      paidByRef.set(row.refsource, row.totalpaid ?? new Prisma.Decimal(0))
    }
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

  const EARNING_RATE = new Prisma.Decimal('0.623')
  const partnerEarnings = new Map<string, Prisma.Decimal>()
  referrals.forEach((ref) => {
    const totalPaid = paidByRef.get(ref.code) ?? new Prisma.Decimal(0)
    const earnings = totalPaid.mul(EARNING_RATE)
    const current = partnerEarnings.get(ref.partnerId) ?? new Prisma.Decimal(0)
    partnerEarnings.set(ref.partnerId, current.add(earnings))
  })

  const out = fs.createWriteStream(filePath, { encoding: 'utf8' })
  let rows = 0

  try {
    const headers = [
      'partner_id',
      'partner_telegram_id',
      'partner_username',
      'ref_code',
      'ref_name',
      'unique_users',
      'total_paid',
      'partner_earnings',
      'partner_paid_out',
      'partner_pending',
      'partner_available',
    ]

    await writeChunk(out, UTF8_BOM + headers.map(csvEscape).join(CSV_DELIMITER) + '\n')

    for (const ref of referrals) {
      const totalPaid = paidByRef.get(ref.code) ?? new Prisma.Decimal(0)
      const earnings = totalPaid.mul(EARNING_RATE)

      const paidOut = partnerPaidOut.get(ref.partnerId) ?? new Prisma.Decimal(0)
      const pending = partnerPending.get(ref.partnerId) ?? new Prisma.Decimal(0)
      const totalPartnerEarnings = partnerEarnings.get(ref.partnerId) ?? new Prisma.Decimal(0)
      const available = totalPartnerEarnings.sub(paidOut).sub(pending)

      const row = [
        ref.partnerId,
        ref.partner.telegramId,
        ref.partner.username || '',
        ref.code,
        ref.name || ref.code,
        countsByRef.get(ref.code) ?? 0,
        totalPaid.toFixed(2),
        earnings.toFixed(2),
        paidOut.toFixed(2),
        pending.toFixed(2),
        available.toFixed(2),
      ]

      await writeChunk(out, row.map(csvEscape).join(CSV_DELIMITER) + '\n')
      rows += 1
    }
  } finally {
    out.end()
  }

  return { filePath, filename, rows }
}
