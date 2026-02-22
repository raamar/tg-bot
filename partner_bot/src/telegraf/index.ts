import { Telegraf, Markup } from 'telegraf'
import type { Update } from 'telegraf/typings/core/types/typegram'
import telegrafThrottler from 'telegraf-throttler'
import { Worker, Job } from 'bullmq'
import { PartnerWithdrawalStatus, Prisma } from '@app/db'

import { redis } from '../redis'
import { prisma } from '../prisma'
import { isAdmin } from '../helpers/isAdmin'
import { clearSession, getSession, setSession } from '../helpers/session'
import { getMenuMessage, setMenuMessage } from '../helpers/menuMessage'
import { clearListMessages, getListMessages, pushListMessage } from '../helpers/listMessages'
import { clearNoticeMessages, getNoticeMessages, pushNoticeMessage } from '../helpers/noticeMessages'
import { exportPartnerRefsCsvToTempFile } from '../helpers/exportPartnerRefsCsv'
import {
  BASE_EARNING_RATE,
  formatCountUi,
  formatMoneyUi,
  formatPercentUi,
  parseAmount,
  parsePercent,
} from '../helpers/money'

if (process.env.TELEGRAM_TOKEN_2 === undefined) {
  throw new Error('TELEGRAM_TOKEN_2 is not defined')
}

if (process.env.TELEGRAM_WEBHOOK_URL_2 === undefined) {
  throw new Error('TELEGRAM_WEBHOOK_URL_2 is not defined')
}

export const bot = new Telegraf(process.env.TELEGRAM_TOKEN_2)
const webhookUrl = new URL(process.env.TELEGRAM_WEBHOOK_URL_2)

const throttler = telegrafThrottler({
  out: {
    minTime: 34,
    reservoir: 30,
    reservoirRefreshAmount: 30,
    reservoirRefreshInterval: 1000,
  },
})

bot.use(throttler)

const REF_LIMIT = 10
const REF_PAGE_SIZE = 5
const WITHDRAW_PAGE_SIZE = 5
const MAIN_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME
const REF_CODE_REGEX = /^[A-Za-z0-9_-]{3,32}$/
const ACQUIRING_FEE_RATE = new Prisma.Decimal(process.env.ACQUIRING_FEE_RATE ?? '0.11')
const ACQUIRING_NET_RATE = new Prisma.Decimal(1).sub(ACQUIRING_FEE_RATE)
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

type AnalyticsType = 'DAY' | 'WEEK' | 'MONTH'
const ANALYTICS_DEFAULT_TYPE: AnalyticsType = 'WEEK'

const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const ensurePartner = async (telegramId: string, username?: string, firstName?: string, lastName?: string) => {
  return prisma.partner.upsert({
    where: { telegramId },
    create: {
      telegramId,
      username,
      firstName,
      lastName,
    },
    update: {
      username,
      firstName,
      lastName,
    },
  })
}

const buildRefLink = (code: string): string => {
  if (!MAIN_BOT_USERNAME) return `https://t.me/USERNAME?start=${code}`
  return `https://t.me/${MAIN_BOT_USERNAME}?start=${code}`
}

const formatCodeBlock = (value: string): string => `<pre><code>${escapeHtml(value)}</code></pre>`

const pad2 = (value: number): string => String(value).padStart(2, '0')

const formatDateRangeMsk = (startMskMs: number, endMskMsExclusive: number): string => {
  const start = new Date(startMskMs)
  const end = new Date(endMskMsExclusive - 1)

  const startLabel = `${pad2(start.getUTCDate())}.${pad2(start.getUTCMonth() + 1)}.${start.getUTCFullYear()}`
  const endLabel = `${pad2(end.getUTCDate())}.${pad2(end.getUTCMonth() + 1)}.${end.getUTCFullYear()}`

  return `${startLabel} - ${endLabel}`
}

const formatMonthYearMsk = (startMskMs: number): string => {
  const date = new Date(startMskMs)
  const raw = date.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  if (!raw) return ''
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

const addMonths = (year: number, month: number, offset: number): { year: number; month: number } => {
  const total = year * 12 + month + offset
  const nextYear = Math.floor(total / 12)
  let nextMonth = total % 12
  if (nextMonth < 0) {
    nextMonth += 12
    return { year: nextYear - 1, month: nextMonth }
  }
  return { year: nextYear, month: nextMonth }
}

const getPeriodStartMskMsForUtc = (dateUtc: Date, type: AnalyticsType): number => {
  const msk = new Date(dateUtc.getTime() + MSK_OFFSET_MS)
  const year = msk.getUTCFullYear()
  const month = msk.getUTCMonth()
  const day = msk.getUTCDate()
  const dayOfWeek = msk.getUTCDay()

  if (type === 'DAY') {
    return Date.UTC(year, month, day, 0, 0, 0)
  }

  if (type === 'WEEK') {
    const diff = (dayOfWeek + 6) % 7
    return Date.UTC(year, month, day, 0, 0, 0) - diff * DAY_MS
  }

  return Date.UTC(year, month, 1, 0, 0, 0)
}

const getPeriodRange = (type: AnalyticsType, offset: number) => {
  const nowMsk = new Date(Date.now() + MSK_OFFSET_MS)
  const year = nowMsk.getUTCFullYear()
  const month = nowMsk.getUTCMonth()
  const day = nowMsk.getUTCDate()
  const dayOfWeek = nowMsk.getUTCDay()

  let startMskMs = 0
  let endMskMs = 0

  if (type === 'DAY') {
    startMskMs = Date.UTC(year, month, day, 0, 0, 0) + offset * DAY_MS
    endMskMs = startMskMs + DAY_MS
  } else if (type === 'WEEK') {
    const diff = (dayOfWeek + 6) % 7
    startMskMs = Date.UTC(year, month, day, 0, 0, 0) - diff * DAY_MS + offset * 7 * DAY_MS
    endMskMs = startMskMs + 7 * DAY_MS
  } else {
    const target = addMonths(year, month, offset)
    startMskMs = Date.UTC(target.year, target.month, 1, 0, 0, 0)
    const next = addMonths(target.year, target.month, 1)
    endMskMs = Date.UTC(next.year, next.month, 1, 0, 0, 0)
  }

  const startUtc = new Date(startMskMs - MSK_OFFSET_MS)
  const endUtc = new Date(endMskMs - MSK_OFFSET_MS)
  const label = formatDateRangeMsk(startMskMs, endMskMs)

  return { startUtc, endUtc, startMskMs, endMskMs, label }
}

const generateReferralCode = async (): Promise<string> => {
  for (let i = 0; i < 5; i += 1) {
    const random = Math.floor(Math.random() * 0xffffff)
    const hex = random.toString(16).padStart(6, '0').toUpperCase()
    const code = hex
    const exists = await prisma.partnerReferral.findUnique({
      where: { code },
      select: { id: true },
    })
    if (!exists) return code
  }
  throw new Error('Не удалось сгенерировать уникальную реф. ссылку')
}

const buildMainMenu = (admin: boolean, withdrawCount: number) => {
  const rows: Array<Array<ReturnType<typeof Markup.button.callback> | ReturnType<typeof Markup.button.url>>> = [
    [Markup.button.callback('🔄 Обновить статистику', 'REFRESH_STATS')],
    [Markup.button.callback('🔗 Реф. ссылки', 'REF_LIST')],
    [Markup.button.callback('🏆 ТОП партнёров', 'TOP_PARTNERS')],
    [Markup.button.callback('📊 Аналитика', 'ANALYTICS')],
    [Markup.button.callback('💸 Запросить вывод', 'WITHDRAW_REQUEST')],
  ]

  if (admin) {
    const label = withdrawCount > 0 ? `🧾 Заявки на вывод (${withdrawCount})` : '🧾 Заявки на вывод'
    rows.push([Markup.button.callback(label, 'ADMIN_WITHDRAW_LIST')])
    rows.push([Markup.button.callback('📥 CSV выгрузка', 'ADMIN_EXPORT_CSV')])
    rows.push([Markup.button.callback('🧮 Изменить ставку реф. ссылки', 'ADMIN_RATE_REF')])
  }

  rows.push([Markup.button.url('ℹ️ Подробнее о проекте', 'https://t.me/ref_neuro_chat')])

  return Markup.inlineKeyboard(rows)
}

const buildWithdrawMenu = (partner: any, available: Prisma.Decimal, pendingCount: number) => {
  const walletLabel = partner.usdtWallet ? '✏️ Изменить кошелёк' : '➕ Указать кошелёк'
  const rows: Array<Array<ReturnType<typeof Markup.button.callback>>> = [[
    Markup.button.callback(walletLabel, 'WITHDRAW_WALLET_SET'),
  ]]

  if (partner.usdtWallet) {
    rows.push([Markup.button.callback('💸 Вывести всё', 'WITHDRAW_ALL')])
    rows.push([Markup.button.callback('✍️ Ввести сумму', 'WITHDRAW_ENTER_AMOUNT')])
  }

  rows.push([Markup.button.callback('⬅️ Назад', 'MAIN_MENU')])

  const warnings: string[] = []
  if (!partner.usdtWallet) warnings.push('Укажите USDT кошелёк (TRC20), чтобы отправить заявку.')
  if (pendingCount >= 2) warnings.push('У вас уже есть 2 заявки в ожидании.')
  if (available.lte(0)) warnings.push('Сейчас нет доступного баланса для вывода.')

  const textRows = ['<b>Вывод средств</b>']
  textRows.push(`🎉 Доступно к выводу: ${formatMoneyUi(available)} ₽`)
  textRows.push(`⏳ Заявок в ожидании: ${pendingCount}/2`)
  textRows.push(partner.usdtWallet ? `👛 Кошелёк: ${escapeHtml(partner.usdtWallet)}` : '👛 Кошелёк: не указан')
  if (warnings.length) {
    textRows.push('')
    warnings.forEach((warning) => textRows.push(`• ${warning}`))
  }

  return {
    text: textRows.join('\n'),
    keyboard: Markup.inlineKeyboard(rows),
  }
}

const sendWithdrawRequestMenu = async (ctx: any) => {
  await clearListForUser(ctx)
  const telegramId = String(ctx.from.id)
  const partner = await ensurePartner(telegramId)
  const stats = await getPartnerStats(partner.id)
  const pendingCount = await prisma.partnerWithdrawal.count({
    where: { partnerId: partner.id, status: PartnerWithdrawalStatus.IN_REVIEW },
  })

  const menu = buildWithdrawMenu(partner, stats.totals.available, pendingCount)
  await sendControlMessage(ctx, menu.text, menu.keyboard)
}

const getPartnerStats = async (partnerId: string) => {
  const referrals = await prisma.partnerReferral.findMany({
    where: { partnerId },
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
  const lastPaidByUserId = new Map<string, Prisma.Decimal>()

  const chunkSize = 5000
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize)
    const payments = await prisma.payment.findMany({
      where: { status: 'PAID', userId: { in: chunk } },
      select: { userId: true, amount: true, paidAt: true, createdAt: true },
      orderBy: [{ userId: 'asc' }, { paidAt: 'desc' }, { createdAt: 'desc' }],
    })

    for (const payment of payments) {
      if (!lastPaidByUserId.has(payment.userId)) {
        lastPaidByUserId.set(payment.userId, payment.amount)
      }
    }
  }

  const paidByRef = new Map<string, Prisma.Decimal>()
  users.forEach((user) => {
    const refSource = user.refSource
    if (!refSource) return
    const amount = lastPaidByUserId.get(user.id)
    if (!amount) return
    const current = paidByRef.get(refSource) ?? new Prisma.Decimal(0)
    paidByRef.set(refSource, current.add(amount))
  })

  const items = referrals.map((ref) => {
    const totalPaid = paidByRef.get(ref.code) ?? new Prisma.Decimal(0)
    const rate = ref.earningRate ?? BASE_EARNING_RATE
    const earnings = totalPaid.mul(rate)
    return {
      referral: ref,
      users: countsByRef.get(ref.code) ?? 0,
      totalPaid,
      earnings,
      rate,
    }
  })

  const totalEarnings = items.reduce((acc, item) => acc.add(item.earnings), new Prisma.Decimal(0))
  const totalUsers = items.reduce((acc, item) => acc + item.users, 0)

  const withdrawals = await prisma.partnerWithdrawal.groupBy({
    by: ['status'],
    where: { partnerId },
    _sum: { amount: true },
  })

  let approved = new Prisma.Decimal(0)
  let pending = new Prisma.Decimal(0)

  withdrawals.forEach((row) => {
    const amount = row._sum.amount ?? new Prisma.Decimal(0)
    if (row.status === PartnerWithdrawalStatus.APPROVED) approved = amount
    if (row.status === PartnerWithdrawalStatus.IN_REVIEW) pending = amount
  })

  let available = totalEarnings.sub(approved).sub(pending)
  if (available.isNegative()) available = new Prisma.Decimal(0)

  return {
    items,
    totals: {
      totalEarnings,
      totalUsers,
      approved,
      pending,
      available,
    },
  }
}

const getAdminPartnerRevenue = async (excludePartnerId: string | null) => {
  const referrals = await prisma.partnerReferral.findMany({
    ...(excludePartnerId ? { where: { partnerId: { not: excludePartnerId } } } : {}),
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

  const userRefById = new Map<string, string>()
  users.forEach((user) => {
    if (!user.refSource) return
    userRefById.set(user.id, user.refSource)
  })

  const userIds = users.map((user) => user.id)
  const lastPaidByUserId = new Map<string, Prisma.Decimal>()

  const chunkSize = 5000
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize)
    const payments = await prisma.payment.findMany({
      where: { status: 'PAID', userId: { in: chunk } },
      select: { userId: true, amount: true, paidAt: true, createdAt: true },
      orderBy: [{ userId: 'asc' }, { paidAt: 'desc' }, { createdAt: 'desc' }],
    })

    for (const payment of payments) {
      if (!lastPaidByUserId.has(payment.userId)) {
        lastPaidByUserId.set(payment.userId, payment.amount)
      }
    }
  }

  const paidByRef = new Map<string, Prisma.Decimal>()
  users.forEach((user) => {
    const refSource = user.refSource
    if (!refSource) return
    const amount = lastPaidByUserId.get(user.id)
    if (!amount) return
    const current = paidByRef.get(refSource) ?? new Prisma.Decimal(0)
    paidByRef.set(refSource, current.add(amount))
  })

  let adminRevenue = new Prisma.Decimal(0)
  referrals.forEach((ref) => {
    const totalPaid = paidByRef.get(ref.code) ?? new Prisma.Decimal(0)
    const rate = ref.earningRate ?? BASE_EARNING_RATE
    const adminRate = ACQUIRING_NET_RATE.sub(rate)
    adminRevenue = adminRevenue.add(totalPaid.mul(adminRate))
  })

  if (adminRevenue.isNegative()) adminRevenue = new Prisma.Decimal(0)
  return { adminRevenue }
}

const getPaidByRefForPeriod = async (
  refCodes: string[],
  startUtc: Date,
  endUtc: Date,
): Promise<{ paidByRef: Map<string, Prisma.Decimal>; usersByRef: Map<string, string> }> => {
  const users =
    refCodes.length === 0
      ? []
      : await prisma.user.findMany({
          where: { refSource: { in: refCodes } },
          select: { id: true, refSource: true },
        })

  const userRefById = new Map<string, string>()
  users.forEach((user) => {
    if (!user.refSource) return
    userRefById.set(user.id, user.refSource)
  })

  const userIds = users.map((user) => user.id)
  const lastPaidByUserId = new Map<string, Prisma.Decimal>()

  const chunkSize = 5000
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize)
    const payments = await prisma.payment.findMany({
      where: {
        status: 'PAID',
        userId: { in: chunk },
        OR: [{ paidAt: { gte: startUtc, lt: endUtc } }, { paidAt: null, createdAt: { gte: startUtc, lt: endUtc } }],
      },
      select: { userId: true, amount: true, paidAt: true, createdAt: true },
      orderBy: [{ userId: 'asc' }, { paidAt: 'desc' }, { createdAt: 'desc' }],
    })

    for (const payment of payments) {
      if (!lastPaidByUserId.has(payment.userId)) {
        lastPaidByUserId.set(payment.userId, payment.amount)
      }
    }
  }

  const paidByRef = new Map<string, Prisma.Decimal>()
  users.forEach((user) => {
    const refSource = user.refSource
    if (!refSource) return
    const amount = lastPaidByUserId.get(user.id)
    if (!amount) return
    const current = paidByRef.get(refSource) ?? new Prisma.Decimal(0)
    paidByRef.set(refSource, current.add(amount))
  })

  return { paidByRef, usersByRef: userRefById }
}

const getPartnerPeriodStats = async (
  partnerId: string,
  startUtc: Date,
  endUtc: Date,
): Promise<{ uniqueUsers: number; earnings: Prisma.Decimal }> => {
  const referrals = await prisma.partnerReferral.findMany({
    where: { partnerId },
    orderBy: { createdAt: 'asc' },
  })

  const refCodes = referrals.map((ref) => ref.code)

  const uniqueUsers = await prisma.user.count({
    where: {
      refSource: { in: refCodes },
      createdAt: { gte: startUtc, lt: endUtc },
    },
  })

  const { paidByRef } = await getPaidByRefForPeriod(refCodes, startUtc, endUtc)

  let earnings = new Prisma.Decimal(0)
  referrals.forEach((ref) => {
    const totalPaid = paidByRef.get(ref.code) ?? new Prisma.Decimal(0)
    const rate = ref.earningRate ?? BASE_EARNING_RATE
    earnings = earnings.add(totalPaid.mul(rate))
  })

  return { uniqueUsers, earnings }
}

const getReferralPeriodStats = async (
  referralCode: string,
  startUtc: Date,
  endUtc: Date,
): Promise<{ uniqueUsers: number; earnings: Prisma.Decimal }> => {
  const uniqueUsers = await prisma.user.count({
    where: {
      refSource: referralCode,
      createdAt: { gte: startUtc, lt: endUtc },
    },
  })

  const { paidByRef } = await getPaidByRefForPeriod([referralCode], startUtc, endUtc)
  const totalPaid = paidByRef.get(referralCode) ?? new Prisma.Decimal(0)

  const referral = await prisma.partnerReferral.findUnique({
    where: { code: referralCode },
    select: { earningRate: true },
  })

  const rate = referral?.earningRate ?? BASE_EARNING_RATE
  const earnings = totalPaid.mul(rate)

  return { uniqueUsers, earnings }
}

const getAdminPartnerRevenueForPeriod = async (
  excludePartnerId: string | null,
  startUtc: Date,
  endUtc: Date,
): Promise<Prisma.Decimal> => {
  const referrals = await prisma.partnerReferral.findMany({
    ...(excludePartnerId ? { where: { partnerId: { not: excludePartnerId } } } : {}),
    orderBy: { createdAt: 'asc' },
  })

  const refCodes = referrals.map((ref) => ref.code)
  const { paidByRef } = await getPaidByRefForPeriod(refCodes, startUtc, endUtc)

  let adminRevenue = new Prisma.Decimal(0)
  referrals.forEach((ref) => {
    const totalPaid = paidByRef.get(ref.code) ?? new Prisma.Decimal(0)
    const rate = ref.earningRate ?? BASE_EARNING_RATE
    const adminRate = ACQUIRING_NET_RATE.sub(rate)
    adminRevenue = adminRevenue.add(totalPaid.mul(adminRate))
  })

  if (adminRevenue.isNegative()) adminRevenue = new Prisma.Decimal(0)
  return adminRevenue
}

const getHasPrevPeriod = async (refCodes: string[], type: AnalyticsType, startMskMs: number): Promise<boolean> => {
  if (!refCodes.length) return false

  const earliestUser = await prisma.user.aggregate({
    where: { refSource: { in: refCodes } },
    _min: { createdAt: true },
  })

  const earliestDate = earliestUser._min.createdAt
  if (!earliestDate) return false

  const earliestStartMskMs = getPeriodStartMskMsForUtc(earliestDate, type)
  return startMskMs > earliestStartMskMs
}

const maskLabel = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) return '***'
  return '*'.repeat(trimmed.length)
}

const getTopPartnersForPeriod = async (startUtc: Date, endUtc: Date) => {
  const referrals = await prisma.partnerReferral.findMany({
    include: { partner: true },
    orderBy: { createdAt: 'asc' },
  })

  const refCodes = referrals.map((ref) => ref.code)
  const { paidByRef } = await getPaidByRefForPeriod(refCodes, startUtc, endUtc)

  const earningsByPartner = new Map<string, Prisma.Decimal>()
  const partnerById = new Map<string, (typeof referrals)[number]['partner']>()

  referrals.forEach((ref) => {
    partnerById.set(ref.partnerId, ref.partner)
    const totalPaid = paidByRef.get(ref.code) ?? new Prisma.Decimal(0)
    const rate = ref.earningRate ?? BASE_EARNING_RATE
    const current = earningsByPartner.get(ref.partnerId) ?? new Prisma.Decimal(0)
    earningsByPartner.set(ref.partnerId, current.add(totalPaid.mul(rate)))
  })

  const list = Array.from(earningsByPartner.entries())
    .map(([partnerId, earnings]) => ({
      partnerId,
      earnings,
      partner: partnerById.get(partnerId),
    }))
    .filter((row) => row.partner)
    .sort((a, b) => b.earnings.comparedTo(a.earnings))

  return list as Array<{ partnerId: string; earnings: Prisma.Decimal; partner: any }>
}

const buildTopPartnersKeyboard = (offset: number, hasPrev: boolean, hasNext: boolean) => {
  const rows: any[] = []
  const navRow: any[] = []
  const spacer = Markup.button.callback('⠀', 'TOP_NOOP')
  if (hasPrev) {
    navRow.push(Markup.button.callback('⬅️', `TOP_NAV:${offset - 1}`))
  } else {
    navRow.push(spacer)
  }
  navRow.push(Markup.button.callback('Обновить', `TOP_REFRESH:${offset}`))
  if (hasNext) {
    navRow.push(Markup.button.callback('➡️', `TOP_NAV:${offset + 1}`))
  } else {
    navRow.push(spacer)
  }
  rows.push(navRow)
  rows.push([Markup.button.callback('⬅️ Назад', 'MAIN_MENU')])
  return Markup.inlineKeyboard(rows)
}

const sendTopPartners = async (ctx: any, offset: number) => {
  const adminViewer = isAdmin(ctx.from?.id)
  const telegramId = String(ctx.from.id)
  const partner = await ensurePartner(telegramId)

  const { startUtc, endUtc, startMskMs, label } = getPeriodRange('MONTH', offset)

  const topList = await getTopPartnersForPeriod(startUtc, endUtc)
  const top10 = topList.slice(0, 10)
  const viewerIndex = topList.findIndex((item) => item.partnerId === partner.id)
  const viewerRank = viewerIndex >= 0 ? viewerIndex + 1 : null

  const refs = await prisma.partnerReferral.findMany({ select: { code: true } })
  const refCodes = refs.map((ref) => ref.code)
  const hasPrev = await getHasPrevPeriod(refCodes, 'MONTH', startMskMs)
  const hasNext = offset < 0

  const monthLabel = formatMonthYearMsk(startMskMs)
  const rows: string[] = [
    '🏆 <b>ТОП партнёров</b>',
    `Период: ${monthLabel}`,
    '',
    '<i>Топ-10 партнёров, по чистому заработку (после вычета всееех комиссий) - прямо сейчас!</i>',
    '',
    '<b>Твоя цель - быть здесь! 👑</b>',
    '',
  ]

  if (!top10.length) {
    rows.push('Пока нет данных.')
  } else {
    top10.forEach((item, index) => {
      const p = item.partner
      const isAdminPartner = p && isAdmin(Number(p.telegramId))
      let display = ''
      if (adminViewer) {
        display = isAdminPartner ? 'Админ' : p.username || p.telegramId
      } else {
        if (isAdminPartner) {
          display = 'Админ'
        } else {
          const base = p.username || p.telegramId
          display = maskLabel(String(base))
        }
      }

      const youLabel = p && p.id === partner.id ? ' (это вы)' : ''
      rows.push(`${index + 1}. ${escapeHtml(display)}${youLabel} — ${formatMoneyUi(item.earnings)} ₽`)
    })

    if (viewerRank && viewerRank > 10) {
      const viewerItem = topList[viewerIndex]
      const p = viewerItem.partner
      const isAdminPartner = p && isAdmin(Number(p.telegramId))
      let display = ''
      if (adminViewer) {
        display = isAdminPartner ? 'Админ' : p.username || p.telegramId
      } else {
        if (isAdminPartner) {
          display = 'Админ'
        } else {
          const base = p.username || p.telegramId
          display = maskLabel(String(base))
        }
      }
      rows.push('...')
      rows.push(`${viewerRank}. ${escapeHtml(display)} (это вы) — ${formatMoneyUi(viewerItem.earnings)} ₽`)
    }
  }

  const keyboard = buildTopPartnersKeyboard(offset, hasPrev, hasNext)
  await clearListForUser(ctx)
  await sendControlMessage(ctx, rows.join('\n'), keyboard)
}

const sendOrEdit = async (
  ctx: any,
  text: string,
  keyboard?: ReturnType<typeof Markup.inlineKeyboard>,
): Promise<void> => {
  const telegramId = String(ctx.from.id)
  const payload = {
    parse_mode: 'HTML' as const,
    disable_web_page_preview: true,
    reply_markup: keyboard ? keyboard.reply_markup : undefined,
  }

  if (ctx.callbackQuery?.message?.message_id) {
    try {
      await ctx.editMessageText(text, payload)
      await setMenuMessage(telegramId, {
        chatId: ctx.callbackQuery.message.chat.id,
        messageId: ctx.callbackQuery.message.message_id,
      })
      return
    } catch (err: any) {
      const msg = err?.description || err?.message || ''
      if (!String(msg).includes('message is not modified')) {
        throw err
      }
    }
  }

  const existing = await getMenuMessage(telegramId)
  if (existing) {
    try {
      await bot.telegram.editMessageText(existing.chatId, existing.messageId, undefined, text, payload)
      return
    } catch {
      // fallback
    }
  }

  const sent = await ctx.reply(text, payload)
  await setMenuMessage(telegramId, { chatId: sent.chat.id, messageId: sent.message_id })
}

const deleteUserMessage = async (ctx: any) => {
  try {
    if (ctx.message?.message_id) {
      await ctx.deleteMessage(ctx.message.message_id)
    }
  } catch {
    // ignore
  }
}

const clearListForUser = async (ctx: any) => {
  const telegramId = String(ctx.from.id)
  const messages = await getListMessages(telegramId)
  for (const msg of messages) {
    try {
      await bot.telegram.deleteMessage(msg.chatId, msg.messageId)
    } catch {
      // ignore delete errors
    }
  }
  await clearListMessages(telegramId)
}

const clearNoticesForUser = async (ctx: any) => {
  const telegramId = String(ctx.from.id)
  const messages = await getNoticeMessages(telegramId)
  for (const msg of messages) {
    try {
      await bot.telegram.deleteMessage(msg.chatId, msg.messageId)
    } catch {
      // ignore
    }
  }
  await clearNoticeMessages(telegramId)
}

const sendNotice = async (ctx: any, text: string) => {
  await clearNoticesForUser(ctx)
  const sent = await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true })
  await pushNoticeMessage(String(ctx.from.id), { chatId: sent.chat.id, messageId: sent.message_id })
}

const sendControlMessage = async (
  ctx: any,
  text: string,
  keyboard?: ReturnType<typeof Markup.inlineKeyboard>,
): Promise<void> => {
  const telegramId = String(ctx.from.id)
  const payload = {
    parse_mode: 'HTML' as const,
    disable_web_page_preview: true,
    reply_markup: keyboard ? keyboard.reply_markup : undefined,
  }

  const existing = await getMenuMessage(telegramId)
  if (existing) {
    try {
      await bot.telegram.deleteMessage(existing.chatId, existing.messageId)
    } catch {
      // ignore
    }
  }

  const sent = await ctx.reply(text, payload)
  await setMenuMessage(telegramId, { chatId: sent.chat.id, messageId: sent.message_id })
}

const sendMainMenu = async (ctx: any, opts?: { clearNotices?: boolean }) => {
  const admin = isAdmin(ctx.from?.id)
  const telegramId = String(ctx.from.id)
  const partner = await ensurePartner(telegramId)
  const stats = await getPartnerStats(partner.id)
  const withdrawCount = admin
    ? await prisma.partnerWithdrawal.count({ where: { status: PartnerWithdrawalStatus.IN_REVIEW } })
    : 0
  const adminRevenue = admin ? (await getAdminPartnerRevenue(partner.id)).adminRevenue : new Prisma.Decimal(0)

  const walletLine = partner.usdtWallet
    ? `👛 USDT кошелёк: ${escapeHtml(partner.usdtWallet)}`
    : '👛 USDT кошелёк: не указан'

  const textRows = [
    '⚙️ <b>Меню партнёра</b> ⚙️\n',
    `🔗 Реф. ссылок: ${formatCountUi(stats.items.length)}`,
    `✨ Уникальные пользователи: ${formatCountUi(stats.totals.totalUsers)}`,
  ]

  if (admin) {
    const totalAll = stats.totals.totalEarnings.add(adminRevenue)
    textRows.push(`🔗 Заработано на реф. ссылках: ${formatMoneyUi(stats.totals.totalEarnings)} ₽`)
    textRows.push(`🤝 Заработано на партнерах: ${formatMoneyUi(adminRevenue)} ₽`)
    textRows.push(`🏆 Заработано всего: ${formatMoneyUi(totalAll)} ₽`)
  } else {
    textRows.push(`💸 Заработано всего: ${formatMoneyUi(stats.totals.totalEarnings)} ₽`)
  }

  textRows.push(`🎉 <b>Доступно к выводу: ${formatMoneyUi(stats.totals.available)} ₽</b>`)
  textRows.push(`⏳ В ожидании выплаты: ${formatMoneyUi(stats.totals.pending)} ₽`)
  textRows.push(`💲 Выплачено: ${formatMoneyUi(stats.totals.approved)} ₽`)
  textRows.push(walletLine)

  const text = textRows.join('\n')

  await clearListForUser(ctx)
  if (opts?.clearNotices) {
    await clearNoticesForUser(ctx)
  }
  await sendControlMessage(ctx, text, buildMainMenu(admin, withdrawCount))
}

const buildAnalyticsKeyboard = (type: AnalyticsType, offset: number, hasPrev: boolean, hasNext: boolean) => {
  const activePrefix = '🔹 '
  const typeLabel = (key: AnalyticsType) => {
    if (key === 'MONTH') return 'Месяц'
    if (key === 'WEEK') return 'Неделя'
    return 'День'
  }

  const typeButton = (key: AnalyticsType) => {
    const isActive = key === type
    const text = isActive ? `${activePrefix}${typeLabel(key)}` : typeLabel(key)
    return Markup.button.callback(text, isActive ? 'ANALYTICS_NOOP' : `ANALYTICS_TYPE:${key}`)
  }

  const rows: any[] = []
  rows.push([typeButton('MONTH'), typeButton('WEEK'), typeButton('DAY')])

  const navRow: any[] = []
  const spacer = Markup.button.callback('⠀', 'ANALYTICS_NOOP')
  if (hasPrev) {
    navRow.push(Markup.button.callback('⬅️', `ANALYTICS_NAV:${type}:${offset - 1}`))
  } else {
    navRow.push(spacer)
  }
  navRow.push(Markup.button.callback('Обновить', `ANALYTICS_REFRESH:${type}:${offset}`))
  if (hasNext) {
    navRow.push(Markup.button.callback('➡️', `ANALYTICS_NAV:${type}:${offset + 1}`))
  } else {
    navRow.push(spacer)
  }

  rows.push(navRow)
  rows.push([Markup.button.callback('⬅️ Назад', 'MAIN_MENU')])

  return Markup.inlineKeyboard(rows)
}

const sendAnalytics = async (ctx: any, type: AnalyticsType, offset: number) => {
  const admin = isAdmin(ctx.from?.id)
  const telegramId = String(ctx.from.id)
  const partner = await ensurePartner(telegramId)
  const { startUtc, endUtc, startMskMs, endMskMs, label } = getPeriodRange(type, offset)

  const partnerStats = await getPartnerPeriodStats(partner.id, startUtc, endUtc)
  const adminRevenue = admin ? await getAdminPartnerRevenueForPeriod(partner.id, startUtc, endUtc) : null

  const refsForPrev = admin
    ? await prisma.partnerReferral.findMany({ select: { code: true } })
    : await prisma.partnerReferral.findMany({ where: { partnerId: partner.id }, select: { code: true } })
  const refCodes = refsForPrev.map((ref) => ref.code)
  const hasPrev = await getHasPrevPeriod(refCodes, type, startMskMs)
  const hasNext = offset < 0

  const rows = [
    '📊 <b>Аналитика</b>',
    `Период: ${label}`,
    '',
    `✨ Уникальные пользователи: ${formatCountUi(partnerStats.uniqueUsers)}`,
  ]
  if (admin) {
    rows.push(`🤝 Заработано на партнёрах: ${formatMoneyUi(adminRevenue ?? new Prisma.Decimal(0))} ₽`)
  }
  const totalAll = admin ? partnerStats.earnings.add(adminRevenue ?? new Prisma.Decimal(0)) : partnerStats.earnings
  rows.push(`🏆 Заработано всего за период: ${formatMoneyUi(totalAll)} ₽`)

  const keyboard = buildAnalyticsKeyboard(type, offset, hasPrev, hasNext)
  await clearListForUser(ctx)
  await sendControlMessage(ctx, rows.join('\n'), keyboard)
}

const buildRefAnalyticsKeyboard = (
  refCode: string,
  type: AnalyticsType,
  offset: number,
  hasPrev: boolean,
  hasNext: boolean,
) => {
  const activePrefix = '🔹 '
  const typeLabel = (key: AnalyticsType) => {
    if (key === 'MONTH') return 'Месяц'
    if (key === 'WEEK') return 'Неделя'
    return 'День'
  }

  const typeButton = (key: AnalyticsType) => {
    const isActive = key === type
    const text = isActive ? `${activePrefix}${typeLabel(key)}` : typeLabel(key)
    return Markup.button.callback(text, isActive ? 'ANALYTICS_NOOP' : `RA_TYPE:${refCode}:${key}`)
  }

  const rows: any[] = []
  rows.push([typeButton('MONTH'), typeButton('WEEK'), typeButton('DAY')])

  const navRow: any[] = []
  const spacer = Markup.button.callback('⠀', 'ANALYTICS_NOOP')
  if (hasPrev) {
    navRow.push(Markup.button.callback('⬅️', `RA_NAV:${refCode}:${type}:${offset - 1}`))
  } else {
    navRow.push(spacer)
  }
  navRow.push(Markup.button.callback('Обновить', `RA_REFRESH:${refCode}:${type}:${offset}`))
  if (hasNext) {
    navRow.push(Markup.button.callback('➡️', `RA_NAV:${refCode}:${type}:${offset + 1}`))
  } else {
    navRow.push(spacer)
  }

  rows.push(navRow)
  rows.push([Markup.button.callback('⬅️ Назад', 'REF_LIST')])

  return Markup.inlineKeyboard(rows)
}

const sendRefAnalytics = async (
  ctx: any,
  ref: { code: string; name?: string | null },
  type: AnalyticsType,
  offset: number,
) => {
  const { startUtc, endUtc, startMskMs, label } = getPeriodRange(type, offset)

  const stats = await getReferralPeriodStats(ref.code, startUtc, endUtc)
  const hasPrev = await getHasPrevPeriod([ref.code], type, startMskMs)
  const hasNext = offset < 0

  const title = ref.name ? `${ref.name} (${ref.code})` : ref.code
  const rows = [
    '📊 <b>Аналитика по реф. ссылке</b>',
    `Реф. ссылка: ${escapeHtml(title)}`,
    `Период: ${label}`,
    '',
    `✨ Уникальные пользователи: ${formatCountUi(stats.uniqueUsers)}`,
    `💸 Заработано всего за период: ${formatMoneyUi(stats.earnings)} ₽`,
  ]

  const keyboard = buildRefAnalyticsKeyboard(ref.code, type, offset, hasPrev, hasNext)
  await clearListForUser(ctx)
  await sendControlMessage(ctx, rows.join('\n'), keyboard)
}

const sendRefList = async (ctx: any) => {
  const rawPage = ctx.match?.[1] ?? ctx.state?.page
  const page = Number.isFinite(Number(rawPage)) ? Number(rawPage) : 1
  const telegramId = String(ctx.from.id)
  const partner = await ensurePartner(telegramId)

  const refs = await prisma.partnerReferral.findMany({
    where: { partnerId: partner.id },
    orderBy: { createdAt: 'asc' },
  })

  const totalPages = Math.max(1, Math.ceil(refs.length / REF_PAGE_SIZE))
  const safePage = Math.min(Math.max(page, 1), totalPages)
  const start = (safePage - 1) * REF_PAGE_SIZE
  const pageRefs = refs.slice(start, start + REF_PAGE_SIZE)

  const rows: any[] = []
  const navRow: any[] = []
  if (safePage > 1) navRow.push(Markup.button.callback('⬅️', `REF_LIST:${safePage - 1}`))
  if (safePage < totalPages) navRow.push(Markup.button.callback('➡️', `REF_LIST:${safePage + 1}`))
  if (navRow.length) rows.push(navRow)

  const bottomRow: any[] = [Markup.button.callback('⬅️ Назад', 'MAIN_MENU')]
  if (refs.length < REF_LIMIT) bottomRow.push(Markup.button.callback('➕ Создать', 'REF_CREATE'))
  rows.push(bottomRow)

  if (isAdmin(ctx.from?.id)) {
    rows.push([Markup.button.callback('🛠 Создать вручную', 'REF_CREATE_MANUAL')])
  }

  if (!refs.length) {
    await clearListForUser(ctx)
    await sendControlMessage(ctx, `<b>Реф. ссылки</b>\nУ вас пока нет реф. ссылок.`, Markup.inlineKeyboard(rows))
    return
  }

  await clearListForUser(ctx)
  for (const ref of pageRefs) {
    const title = ref.name ? `${ref.name} (${ref.code})` : ref.code
    const text = [`${escapeHtml(title)}`, formatCodeBlock(buildRefLink(ref.code))].join('\n')
    const sent = await ctx.reply(text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: Markup.inlineKeyboard([
        [
          Markup.button.callback('📊 Статистика', `REF_STATS:${ref.id}`),
          Markup.button.callback('✏️ Переименовать', `REF_RENAME:${ref.id}`),
        ],
      ]).reply_markup,
    })
    await pushListMessage(telegramId, { chatId: sent.chat.id, messageId: sent.message_id })
  }

  await sendControlMessage(
    ctx,
    `<b>Мои реф. ссылки</b>\nСтраница ${safePage} из ${totalPages}`,
    Markup.inlineKeyboard(rows),
  )
}

const withErrorHandling = (handler: (ctx: any) => Promise<void>) => async (ctx: any) => {
  try {
    await handler(ctx)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Partner bot error:', message)
    await ctx.reply('Произошла ошибка, попробуйте позже.')
  }
}

bot.start(
  withErrorHandling(async (ctx) => {
    const from = ctx.from
    const telegramId = String(from?.id)
    const startText = ctx.message?.text
    const recruitRefCode = startText?.split(' ')[1]?.trim()

    const partner = await ensurePartner(telegramId, from?.username, from?.first_name, from?.last_name)

    if (!partner.recruitReferralId && recruitRefCode) {
      const recruitReferral = await prisma.recruitPartnerReferral.findUnique({
        where: { code: recruitRefCode },
        select: { id: true },
      })

      if (recruitReferral) {
        await prisma.partner.update({
          where: { id: partner.id },
          data: { recruitReferralId: recruitReferral.id },
        })
      }
    }

    await clearSession(telegramId)
    await sendMainMenu(ctx, { clearNotices: true })
  }),
)

bot.action(
  'MAIN_MENU',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    await clearListForUser(ctx)
    await sendMainMenu(ctx, { clearNotices: true })
  }),
)

bot.action(
  'REFRESH_STATS',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    await clearListForUser(ctx)
    await sendMainMenu(ctx, { clearNotices: true })
  }),
)

bot.action(
  'ANALYTICS',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    await sendAnalytics(ctx, ANALYTICS_DEFAULT_TYPE, 0)
  }),
)

bot.action(
  'TOP_PARTNERS',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    await sendTopPartners(ctx, 0)
  }),
)

bot.action(
  /^TOP_NAV:(-?\d+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    const offset = Number(ctx.match[1])
    if (!Number.isFinite(offset)) {
      await sendTopPartners(ctx, 0)
      return
    }
    await sendTopPartners(ctx, offset)
  }),
)

bot.action(
  /^TOP_REFRESH:(-?\d+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    const offset = Number(ctx.match[1])
    if (!Number.isFinite(offset)) {
      await sendTopPartners(ctx, 0)
      return
    }
    await sendTopPartners(ctx, offset)
  }),
)

bot.action(
  'TOP_NOOP',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
  }),
)

bot.action(
  /^ANALYTICS_NAV:(DAY|WEEK|MONTH):(-?\d+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    const type = ctx.match[1] as AnalyticsType
    const offset = Number(ctx.match[2])
    if (!Number.isFinite(offset)) {
      await sendAnalytics(ctx, ANALYTICS_DEFAULT_TYPE, 0)
      return
    }
    await sendAnalytics(ctx, type, offset)
  }),
)

const getOffsetFromFocus = (type: AnalyticsType, focusStartMskMs: number): number => {
  const current = getPeriodRange(type, 0)
  const currentStart = current.startMskMs

  if (type === 'DAY') {
    return Math.round((focusStartMskMs - currentStart) / DAY_MS)
  }
  if (type === 'WEEK') {
    return Math.round((focusStartMskMs - currentStart) / (7 * DAY_MS))
  }

  const focus = new Date(focusStartMskMs)
  const currentDate = new Date(currentStart)
  const focusYear = focus.getUTCFullYear()
  const focusMonth = focus.getUTCMonth()
  const currentYear = currentDate.getUTCFullYear()
  const currentMonth = currentDate.getUTCMonth()
  return (focusYear - currentYear) * 12 + (focusMonth - currentMonth)
}

bot.action(
  /^ANALYTICS_TYPE:(DAY|WEEK|MONTH)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    const type = ctx.match[1] as AnalyticsType
    await sendAnalytics(ctx, type, 0)
  }),
)

bot.action(
  /^ANALYTICS_REFRESH:(DAY|WEEK|MONTH):(-?\d+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    const type = ctx.match[1] as AnalyticsType
    const offset = Number(ctx.match[2])
    if (!Number.isFinite(offset)) {
      await sendAnalytics(ctx, ANALYTICS_DEFAULT_TYPE, 0)
      return
    }
    await sendAnalytics(ctx, type, offset)
  }),
)

bot.action(
  'ANALYTICS_NOOP',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
  }),
)

bot.action(
  /^REF_LIST(?::(\d+))?$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    if (ctx.match?.[1] && Number.isFinite(Number(ctx.match[1]))) {
      ctx.state.page = Number(ctx.match[1])
    }
    await sendRefList(ctx)
  }),
)

bot.action(
  'REF_CREATE',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    const telegramId = String(ctx.from.id)
    const partner = await ensurePartner(telegramId)

    const count = await prisma.partnerReferral.count({ where: { partnerId: partner.id } })
    if (count >= REF_LIMIT) {
      await sendNotice(ctx, `Максимум ${REF_LIMIT} реф. ссылок`)
      await sendRefList(ctx)
      return
    }

    const code = await generateReferralCode()
    const referral = await prisma.partnerReferral.create({
      data: {
        partnerId: partner.id,
        code,
      },
    })

    await setSession(telegramId, { action: 'REF_NAME_CREATE', referralId: referral.id })

    const text = [
      '<b>Реф. ссылка создана</b>',
      escapeHtml(code),
      formatCodeBlock(buildRefLink(code)),
      'Введите название для удобства или нажмите ОК.',
    ].join('\n')

    await sendControlMessage(
      ctx,
      text,
      Markup.inlineKeyboard([[Markup.button.callback('ОК', `REF_NAME_SKIP:${referral.id}`)]]),
    )
  }),
)

bot.action(
  'REF_CREATE_MANUAL',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    if (!isAdmin(ctx.from?.id)) {
      await sendNotice(ctx, 'Недостаточно прав')
      await sendRefList(ctx)
      return
    }
    const telegramId = String(ctx.from.id)
    await setSession(telegramId, { action: 'REF_CREATE_MANUAL_CODE' })
    await sendControlMessage(
      ctx,
      'Введите реф-код (латиница/цифры, можно _ и -), без пробелов.',
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'REF_LIST')]]),
    )
  }),
)

bot.action(
  /^REF_NAME_SKIP:(.+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    const referralId = ctx.match[1]
    await prisma.partnerReferral.update({
      where: { id: referralId },
      data: { name: null },
    })
    await clearSession(String(ctx.from.id))
    await sendNotice(ctx, 'Название сохранено')
    await sendRefList(ctx)
  }),
)

bot.action(
  /^REF_RENAME:(.+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    const referralId = ctx.match[1]
    const telegramId = String(ctx.from.id)

    await setSession(telegramId, { action: 'REF_NAME_EDIT', referralId })
    await sendControlMessage(
      ctx,
      'Введите новое название реф. ссылки.',
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'REF_LIST')]]),
    )
  }),
)

bot.action(
  /^REF_STATS:(.+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearListForUser(ctx)
    const referralId = ctx.match[1]
    const telegramId = String(ctx.from.id)
    const partner = await ensurePartner(telegramId)

    const referral = await prisma.partnerReferral.findFirst({
      where: { id: referralId, partnerId: partner.id },
    })

    if (!referral) {
      await sendNotice(ctx, 'Реф. ссылка не найдена')
      await sendRefList(ctx)
      return
    }

    const stats = await getPartnerStats(partner.id)
    const item = stats.items.find((it) => it.referral.id === referral.id)

    if (!item) {
      await sendNotice(ctx, 'Статистика недоступна')
      await sendRefList(ctx)
      return
    }

    const text = [
      `<b>Реф. ссылка:</b> ${escapeHtml(referral.name || referral.code)}`,
      `Код: ${escapeHtml(referral.code)}`,
      formatCodeBlock(buildRefLink(referral.code)),
      `✨ Уникальные пользователи: ${formatCountUi(item.users)}`,
      `💸 Заработано всего: ${formatMoneyUi(item.earnings)} ₽`,
    ].join('\n')

    await sendControlMessage(
      ctx,
      text,
      Markup.inlineKeyboard([
        [Markup.button.callback('📊 Аналитика', `RA:${referral.code}:${ANALYTICS_DEFAULT_TYPE}:0`)],
        [Markup.button.callback('⬅️ Назад', 'REF_LIST')],
      ]),
    )
  }),
)

bot.action(
  /^RA:([^:]+):(DAY|WEEK|MONTH):(-?\d+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    const refCode = ctx.match[1]
    const type = ctx.match[2] as AnalyticsType
    const offset = Number(ctx.match[3])
    if (!Number.isFinite(offset)) {
      await sendRefList(ctx)
      return
    }
    const referral = await prisma.partnerReferral.findUnique({ where: { code: refCode } })
    if (!referral) {
      await sendNotice(ctx, 'Реф. ссылка не найдена')
      await sendRefList(ctx)
      return
    }
    await sendRefAnalytics(ctx, referral, type, offset)
  }),
)

bot.action(
  /^RA_NAV:([^:]+):(DAY|WEEK|MONTH):(-?\d+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    const refCode = ctx.match[1]
    const type = ctx.match[2] as AnalyticsType
    const offset = Number(ctx.match[3])
    if (!Number.isFinite(offset)) {
      await sendRefList(ctx)
      return
    }
    const referral = await prisma.partnerReferral.findUnique({ where: { code: refCode } })
    if (!referral) {
      await sendNotice(ctx, 'Реф. ссылка не найдена')
      await sendRefList(ctx)
      return
    }
    await sendRefAnalytics(ctx, referral, type, offset)
  }),
)

bot.action(
  /^RA_TYPE:([^:]+):(DAY|WEEK|MONTH)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    const refCode = ctx.match[1]
    const type = ctx.match[2] as AnalyticsType
    const referral = await prisma.partnerReferral.findUnique({ where: { code: refCode } })
    if (!referral) {
      await sendNotice(ctx, 'Реф. ссылка не найдена')
      await sendRefList(ctx)
      return
    }
    await sendRefAnalytics(ctx, referral, type, 0)
  }),
)

bot.action(
  /^RA_REFRESH:([^:]+):(DAY|WEEK|MONTH):(-?\d+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    const refCode = ctx.match[1]
    const type = ctx.match[2] as AnalyticsType
    const offset = Number(ctx.match[3])
    if (!Number.isFinite(offset)) {
      await sendRefList(ctx)
      return
    }
    const referral = await prisma.partnerReferral.findUnique({ where: { code: refCode } })
    if (!referral) {
      await sendNotice(ctx, 'Реф. ссылка не найдена')
      await sendRefList(ctx)
      return
    }
    await sendRefAnalytics(ctx, referral, type, offset)
  }),
)

bot.action(
  'WALLET_SET',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearListForUser(ctx)
    const telegramId = String(ctx.from.id)
    const partner = await ensurePartner(telegramId)
    await setSession(telegramId, { action: 'SET_WALLET', returnTo: 'MAIN_MENU' })
    const title = partner.usdtWallet ? 'Изменить кошелёк' : 'Указать кошелёк'
    const current = partner.usdtWallet ? `Текущий: ${escapeHtml(partner.usdtWallet)}\n` : ''
    await sendControlMessage(
      ctx,
      `<b>${title}</b>\n${current}Введите ваш USDT кошелёк в сети TRC20.`,
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'MAIN_MENU')]]),
    )
  }),
)

bot.action(
  'WITHDRAW_WALLET_SET',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearListForUser(ctx)
    const telegramId = String(ctx.from.id)
    const partner = await ensurePartner(telegramId)
    await setSession(telegramId, { action: 'SET_WALLET', returnTo: 'WITHDRAW_MENU' })
    const title = partner.usdtWallet ? 'Изменить кошелёк' : 'Указать кошелёк'
    const current = partner.usdtWallet ? `Текущий: ${escapeHtml(partner.usdtWallet)}\n` : ''
    await sendControlMessage(
      ctx,
      `<b>${title}</b>\n${current}Введите ваш USDT кошелёк в сети TRC20.`,
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'WITHDRAW_REQUEST')]]),
    )
  }),
)

bot.action(
  'WITHDRAW_REQUEST',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await sendWithdrawRequestMenu(ctx)
  }),
)

bot.action(
  'WITHDRAW_ENTER_AMOUNT',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearListForUser(ctx)
    const telegramId = String(ctx.from.id)
    const partner = await ensurePartner(telegramId)
    const stats = await getPartnerStats(partner.id)
    const pendingCount = await prisma.partnerWithdrawal.count({
      where: { partnerId: partner.id, status: PartnerWithdrawalStatus.IN_REVIEW },
    })
    if (pendingCount >= 2) {
      await sendControlMessage(
        ctx,
        'У вас уже есть 2 заявки в ожидании. Дождитесь решения по ним.',
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'WITHDRAW_REQUEST')]]),
      )
      return
    }

    if (!partner.usdtWallet) {
      await sendControlMessage(
        ctx,
        'Сначала укажите USDT кошелёк в сети TRC20.',
        Markup.inlineKeyboard([
          [Markup.button.callback('➕ Указать кошелёк', 'WITHDRAW_WALLET_SET')],
          [Markup.button.callback('⬅️ Назад', 'WITHDRAW_REQUEST')],
        ]),
      )
      return
    }

    if (stats.totals.available.lte(0)) {
      await sendControlMessage(
        ctx,
        'Сейчас нет доступного баланса для вывода.',
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'WITHDRAW_REQUEST')]]),
      )
      return
    }

    await setSession(telegramId, { action: 'WITHDRAW_AMOUNT' })
    await sendControlMessage(
      ctx,
      `Введите сумму для вывода (доступно ${formatMoneyUi(stats.totals.available)} ₽) или нажмите «Вывести всё».`,
      Markup.inlineKeyboard([
        [Markup.button.callback('💸 Вывести всё', 'WITHDRAW_ALL')],
        [Markup.button.callback('⬅️ Назад', 'WITHDRAW_REQUEST')],
      ]),
    )
  }),
)

bot.action(
  'WITHDRAW_ALL',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearListForUser(ctx)
    const telegramId = String(ctx.from.id)
    const partner = await ensurePartner(telegramId)
    const stats = await getPartnerStats(partner.id)
    const pendingCount = await prisma.partnerWithdrawal.count({
      where: { partnerId: partner.id, status: PartnerWithdrawalStatus.IN_REVIEW },
    })

    if (pendingCount >= 2) {
      await sendControlMessage(
        ctx,
        'У вас уже есть 2 заявки в ожидании. Дождитесь решения по ним.',
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'WITHDRAW_REQUEST')]]),
      )
      return
    }

    if (!partner.usdtWallet) {
      await sendControlMessage(
        ctx,
        'Сначала укажите USDT кошелёк в сети TRC20.',
        Markup.inlineKeyboard([
          [Markup.button.callback('➕ Указать кошелёк', 'WITHDRAW_WALLET_SET')],
          [Markup.button.callback('⬅️ Назад', 'WITHDRAW_REQUEST')],
        ]),
      )
      return
    }

    if (stats.totals.available.lte(0)) {
      await sendControlMessage(
        ctx,
        'Сейчас нет доступного баланса для вывода.',
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'WITHDRAW_REQUEST')]]),
      )
      return
    }

    await createWithdrawalRequest(ctx, partner, stats.totals.available)
  }),
)

bot.action(
  /^ADMIN_WITHDRAW_LIST(?::(\d+))?$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearListForUser(ctx)
    if (ctx.match?.[1] && Number.isFinite(Number(ctx.match[1]))) {
      ctx.state.page = Number(ctx.match[1])
    }

    if (!isAdmin(ctx.from?.id)) {
      await sendNotice(ctx, 'Недостаточно прав')
      await sendMainMenu(ctx)
      return
    }

    const rawPage = ctx.match?.[1] ?? ctx.state?.page
    const page = Number.isFinite(Number(rawPage)) ? Number(rawPage) : 1
    const withdrawals = await prisma.partnerWithdrawal.findMany({
      where: { status: PartnerWithdrawalStatus.IN_REVIEW },
      include: { partner: true },
      orderBy: { createdAt: 'asc' },
    })

    if (!withdrawals.length) {
      await sendNotice(ctx, 'Нет заявок в работе')
      await sendMainMenu(ctx)
      return
    }

    await clearListForUser(ctx)
    const totalPages = Math.max(1, Math.ceil(withdrawals.length / WITHDRAW_PAGE_SIZE))
    const safePage = Math.min(Math.max(page, 1), totalPages)
    const start = (safePage - 1) * WITHDRAW_PAGE_SIZE
    const pageItems = withdrawals.slice(start, start + WITHDRAW_PAGE_SIZE)

    const navRows: any[] = []
    const nav: any[] = []
    if (safePage > 1) nav.push(Markup.button.callback('⬅️', `ADMIN_WITHDRAW_LIST:${safePage - 1}`))
    if (safePage < totalPages) nav.push(Markup.button.callback('➡️', `ADMIN_WITHDRAW_LIST:${safePage + 1}`))
    if (nav.length) navRows.push(nav)
    navRows.push([Markup.button.callback('⬅️ Назад', 'MAIN_MENU')])

    await sendControlMessage(
      ctx,
      `<b>Заявки на вывод</b>\nСтраница ${safePage} из ${totalPages}`,
      Markup.inlineKeyboard(navRows),
    )

    for (const withdrawal of pageItems) {
      const partnerLabel = withdrawal.partner.username || withdrawal.partner.telegramId
      const text = [
        `Заявка: ${withdrawal.id}`,
        `Партнёр: ${partnerLabel}`,
        `Telegram ID: ${withdrawal.partner.telegramId}`,
        `Кошелёк: ${withdrawal.partner.usdtWallet || 'не указан'}`,
        `Сумма: ${formatMoneyUi(withdrawal.amount)} ₽`,
      ].join('\n')

      const sent = await ctx.reply(text, {
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Одобрить', `ADMIN_APPROVE:${withdrawal.id}`),
            Markup.button.callback('❌ Отклонить', `ADMIN_REJECT:${withdrawal.id}`),
          ],
        ]).reply_markup,
      })
      await pushListMessage(String(ctx.from.id), { chatId: sent.chat.id, messageId: sent.message_id })
    }
  }),
)

bot.action(
  'ADMIN_EXPORT_CSV',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearListForUser(ctx)

    if (!isAdmin(ctx.from?.id)) {
      await sendNotice(ctx, 'Недостаточно прав')
      await sendMainMenu(ctx)
      return
    }

    const { filePath, filename, rows } = await exportPartnerRefsCsvToTempFile(prisma)

    if (!rows) {
      await sendNotice(ctx, 'Нет данных для выгрузки')
      await sendMainMenu(ctx)
      return
    }

    await ctx.replyWithDocument({ source: filePath, filename })
  }),
)

bot.action(
  'ADMIN_RATE_REF',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearListForUser(ctx)

    if (!isAdmin(ctx.from?.id)) {
      await sendNotice(ctx, 'Недостаточно прав')
      await sendMainMenu(ctx)
      return
    }

    const telegramId = String(ctx.from.id)
    await setSession(telegramId, { action: 'ADMIN_RATE_REF_CODE' })
    await sendControlMessage(
      ctx,
      'Введите реф-код, для которого нужно изменить ставку.',
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'MAIN_MENU')]]),
    )
  }),
)

bot.action(
  /^ADMIN_APPROVE:(.+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearListForUser(ctx)

    if (!isAdmin(ctx.from?.id)) {
      await sendNotice(ctx, 'Недостаточно прав')
      await sendMainMenu(ctx)
      return
    }

    const withdrawalId = ctx.match[1]
    await setSession(String(ctx.from.id), { action: 'ADMIN_APPROVE_LINK', withdrawalId })
    await sendControlMessage(
      ctx,
      'Введите данные транзакции в TronScan.',
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'MAIN_MENU')]]),
    )
  }),
)

bot.action(
  /^ADMIN_REJECT:(.+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearListForUser(ctx)

    if (!isAdmin(ctx.from?.id)) {
      await sendNotice(ctx, 'Недостаточно прав')
      await sendMainMenu(ctx)
      return
    }

    const withdrawalId = ctx.match[1]
    await setSession(String(ctx.from.id), { action: 'ADMIN_REJECT_REASON', withdrawalId })
    await sendControlMessage(
      ctx,
      'Введите причину отклонения.',
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'MAIN_MENU')]]),
    )
  }),
)

bot.on(
  'message',
  withErrorHandling(async (ctx) => {
    const telegramId = String(ctx.from.id)
    const session = await getSession(telegramId)

    if (!session) {
      await sendMainMenu(ctx)
      return
    }

    if (session.action === 'REF_CREATE_MANUAL_CODE') {
      if (!isAdmin(ctx.from?.id)) {
        await clearSession(telegramId)
        await sendNotice(ctx, 'Недостаточно прав')
        await sendMainMenu(ctx)
        return
      }

      const codeText = ctx.message?.text?.trim()
      if (!codeText) {
        await sendNotice(ctx, 'Введите реф-код текстом.')
        await deleteUserMessage(ctx)
        return
      }

      if (!REF_CODE_REGEX.test(codeText)) {
        await sendNotice(ctx, 'Неверный формат. Пример: A1B2C3')
        await deleteUserMessage(ctx)
        return
      }

      const exists = await prisma.partnerReferral.findUnique({ where: { code: codeText } })
      if (exists) {
        await sendNotice(ctx, 'Такой код уже существует.')
        await deleteUserMessage(ctx)
        return
      }

      const partner = await ensurePartner(telegramId)
      const count = await prisma.partnerReferral.count({ where: { partnerId: partner.id } })
      if (count >= REF_LIMIT) {
        await clearSession(telegramId)
        await sendNotice(ctx, `Максимум ${REF_LIMIT} реф. ссылок`)
        await sendRefList(ctx)
        return
      }

      const referral = await prisma.partnerReferral.create({
        data: {
          partnerId: partner.id,
          code: codeText,
        },
      })

      await setSession(telegramId, { action: 'REF_NAME_CREATE', referralId: referral.id })

      const text = [
        '<b>Реф. ссылка создана</b>',
        escapeHtml(codeText),
        formatCodeBlock(buildRefLink(codeText)),
        'Введите название для удобства или нажмите ОК.',
      ].join('\n')

      await sendControlMessage(
        ctx,
        text,
        Markup.inlineKeyboard([[Markup.button.callback('ОК', `REF_NAME_SKIP:${referral.id}`)]]),
      )
      await deleteUserMessage(ctx)

      return
    }

    if (session.action === 'SET_WALLET') {
      const wallet = ctx.message?.text
      if (!wallet) {
        await sendNotice(ctx, 'Нужен текстовый кошелёк.')
        await deleteUserMessage(ctx)
        return
      }
      await prisma.partner.update({
        where: { telegramId },
        data: { usdtWallet: wallet.trim() },
      })
      await clearSession(telegramId)
      await sendNotice(ctx, 'Кошелёк сохранён')
      if (session.returnTo === 'WITHDRAW_MENU') {
        await sendWithdrawRequestMenu(ctx)
      } else {
        await sendMainMenu(ctx)
      }
      await deleteUserMessage(ctx)
      return
    }

    if (session.action === 'REF_NAME_CREATE' || session.action === 'REF_NAME_EDIT') {
      const nameText = ctx.message?.text
      if (!nameText) {
        await sendNotice(ctx, 'Введите текстовое название.')
        await deleteUserMessage(ctx)
        return
      }

      const name = nameText.trim()

      await prisma.partnerReferral.update({
        where: { id: session.referralId },
        data: { name },
      })
      await clearSession(telegramId)
      await sendNotice(ctx, 'Название сохранено')
      await sendRefList(ctx)
      await deleteUserMessage(ctx)
      return
    }

    if (session.action === 'WITHDRAW_AMOUNT') {
      const text = ctx.message?.text
      if (!text) {
        await sendNotice(ctx, 'Введите сумму цифрами.')
        await deleteUserMessage(ctx)
        return
      }

      const amount = parseAmount(text)
      if (!amount) {
        await sendNotice(ctx, 'Неверная сумма. Попробуйте снова.')
        await deleteUserMessage(ctx)
        return
      }

      const partner = await prisma.partner.findUnique({ where: { telegramId } })
      if (!partner) {
        await clearSession(telegramId)
        await sendNotice(ctx, 'Партнёр не найден')
        await sendMainMenu(ctx)
        return
      }

      if (!partner.usdtWallet) {
        await clearSession(telegramId)
        await sendControlMessage(
          ctx,
          'Сначала укажите USDT кошелёк в сети TRC20.',
          Markup.inlineKeyboard([
            [Markup.button.callback('➕ Указать кошелёк', 'WITHDRAW_WALLET_SET')],
            [Markup.button.callback('⬅️ Назад', 'WITHDRAW_REQUEST')],
          ]),
        )
        await deleteUserMessage(ctx)
        return
      }

      await createWithdrawalRequest(ctx, partner, new Prisma.Decimal(amount))
      await deleteUserMessage(ctx)
      return
    }

    if (session.action === 'ADMIN_RATE_REF_CODE') {
      if (!isAdmin(ctx.from?.id)) {
        await clearSession(telegramId)
        await sendNotice(ctx, 'Недостаточно прав')
        await sendMainMenu(ctx)
        return
      }

      const code = ctx.message?.text?.trim()
      if (!code || !REF_CODE_REGEX.test(code)) {
        await sendNotice(ctx, 'Неверный формат реф-кода.')
        await deleteUserMessage(ctx)
        return
      }

      const referral = await prisma.partnerReferral.findUnique({ where: { code } })
      if (!referral) {
        await sendNotice(ctx, 'Реф. ссылка не найдена')
        await deleteUserMessage(ctx)
        return
      }

      const currentRate = referral.earningRate ?? BASE_EARNING_RATE
      await setSession(telegramId, { action: 'ADMIN_RATE_REF_VALUE', referralId: referral.id })

      const feePercent = formatPercentUi(ACQUIRING_FEE_RATE)
      const text = [
        `<b>Реф. ссылка:</b> ${escapeHtml(referral.name || referral.code)}`,
        `Код: ${escapeHtml(referral.code)}`,
        '',
        `Текущая ставка: ${formatPercentUi(currentRate)}%`,
        `Комиссия эквайринга: ${feePercent}%`,
        `Базовая ставка считается так: (100% - ${feePercent}%) x 70% = 62.3%`,
        `Важно: если указать больше ${formatPercentUi(ACQUIRING_NET_RATE)}%, админ уйдёт в минус.`,
        '',
        'Введите новый процент выплат (например 62.3).',
      ].join('\n')

      await sendControlMessage(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'MAIN_MENU')]]))
      await deleteUserMessage(ctx)
      return
    }

    if (session.action === 'ADMIN_RATE_REF_VALUE') {
      if (!isAdmin(ctx.from?.id)) {
        await clearSession(telegramId)
        await sendNotice(ctx, 'Недостаточно прав')
        await sendMainMenu(ctx)
        return
      }

      const valueText = ctx.message?.text
      if (!valueText) {
        await sendNotice(ctx, 'Введите процент числом.')
        await deleteUserMessage(ctx)
        return
      }

      const percent = parsePercent(valueText)
      if (!percent) {
        await sendNotice(ctx, 'Неверный процент. Пример: 62.3')
        await deleteUserMessage(ctx)
        return
      }

      const rate = new Prisma.Decimal(percent).div(100)
      await prisma.partnerReferral.update({
        where: { id: session.referralId },
        data: { earningRate: rate },
      })

      await clearSession(telegramId)
      await sendNotice(ctx, 'Ставка обновлена')
      await sendMainMenu(ctx)
      await deleteUserMessage(ctx)
      return
    }

    if (session.action === 'ADMIN_REJECT_REASON') {
      if (!isAdmin(ctx.from?.id)) {
        await clearSession(telegramId)
        await sendNotice(ctx, 'Недостаточно прав')
        await sendMainMenu(ctx)
        return
      }

      const reason = ctx.message?.text?.trim()
      if (!reason) {
        await sendNotice(ctx, 'Нужна причина отклонения.')
        await deleteUserMessage(ctx)
        return
      }

      const withdrawal = await prisma.partnerWithdrawal.findUnique({
        where: { id: session.withdrawalId },
        include: { partner: true },
      })

      if (!withdrawal || withdrawal.status !== PartnerWithdrawalStatus.IN_REVIEW) {
        await clearSession(telegramId)
        await sendNotice(ctx, 'Заявка недоступна для отклонения')
        await sendMainMenu(ctx)
        return
      }

      await prisma.partnerWithdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: PartnerWithdrawalStatus.REJECTED,
          reason,
          decidedAt: new Date(),
        },
      })

      await clearSession(telegramId)
      await sendNotice(ctx, 'Заявка отклонена')
      await sendMainMenu(ctx)
      await deleteUserMessage(ctx)

      await bot.telegram.sendMessage(
        withdrawal.partner.telegramId,
        `❌ Ваша заявка на вывод отклонена. Причина: ${reason}`,
      )

      return
    }

    if (session.action === 'ADMIN_APPROVE_LINK') {
      if (!isAdmin(ctx.from?.id)) {
        await clearSession(telegramId)
        await sendNotice(ctx, 'Недостаточно прав')
        await sendMainMenu(ctx)
        return
      }

      const withdrawal = await prisma.partnerWithdrawal.findUnique({
        where: { id: session.withdrawalId },
        include: { partner: true },
      })

      if (!withdrawal || withdrawal.status !== PartnerWithdrawalStatus.IN_REVIEW) {
        await clearSession(telegramId)
        await sendNotice(ctx, 'Заявка недоступна для подтверждения')
        await sendMainMenu(ctx)
        return
      }

      const linkText = ctx.message?.text?.trim()
      if (!linkText || !/^https?:\/\//i.test(linkText)) {
        await sendNotice(ctx, 'Нужна ссылка на выплату (начиная с http/https).')
        await deleteUserMessage(ctx)
        return
      }

      await prisma.partnerWithdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: PartnerWithdrawalStatus.APPROVED,
          receiptUrl: linkText,
          receiptKey: null,
          decidedAt: new Date(),
        },
      })

      await clearSession(telegramId)
      await sendNotice(ctx, 'Заявка подтверждена')
      await sendMainMenu(ctx)
      await deleteUserMessage(ctx)

      await bot.telegram.sendMessage(
        withdrawal.partner.telegramId,
        [
          '✅ Ваша заявка на вывод одобрена!',
          `💸 Сумма: ${formatMoneyUi(withdrawal.amount)} ₽`,
          `🔗 Данные транзакции: ${escapeHtml(linkText)}`,
          '<b>🔥 Ожидайте, выплата придёт в течении 5-30 минут!</b>',
        ].join('\n'),
        {
          parse_mode: 'HTML',
          link_preview_options: {
            is_disabled: true,
          },
        },
      )

      return
    }
  }),
)

const createWithdrawalRequest = async (ctx: any, partner: any, amount: Prisma.Decimal) => {
  const telegramId = String(ctx.from.id)
  const stats = await getPartnerStats(partner.id)
  const roundedAmount = amount.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
  if (roundedAmount.lte(0)) {
    await sendNotice(ctx, 'Сумма должна быть больше 0.')
    return
  }

  if (roundedAmount.gt(stats.totals.available)) {
    await sendNotice(ctx, `Сумма превышает доступный баланс (${formatMoneyUi(stats.totals.available)} ₽).`)
    return
  }

  const withdrawal = await prisma.partnerWithdrawal.create({
    data: {
      partnerId: partner.id,
      amount: roundedAmount,
      status: PartnerWithdrawalStatus.IN_REVIEW,
    },
  })

  await clearSession(telegramId)
  await sendNotice(ctx, 'Заявка на вывод создана')
  await sendMainMenu(ctx)

  const admins = process.env.ADMIN_IDS?.split(',').map(Number).filter(Boolean) || []
  if (admins.length) {
    const text = [
      '🧾 Новая заявка на вывод',
      `ID: ${withdrawal.id}`,
      `Партнёр: ${partner.username || partner.telegramId}`,
      `Сумма: ${formatMoneyUi(withdrawal.amount)} ₽`,
    ].join('\n')

    await Promise.allSettled(
      admins.map((adminId) =>
        bot.telegram.sendMessage(adminId, text, {
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Одобрить', `ADMIN_APPROVE:${withdrawal.id}`),
              Markup.button.callback('❌ Отклонить', `ADMIN_REJECT:${withdrawal.id}`),
            ],
          ]).reply_markup,
        }),
      ),
    )
  }
}

const partnerTelegramWorker = new Worker<Update>(
  'telegram_bot2',
  async (job: Job<Update>) => {
    await bot.handleUpdate(job.data)
  },
  {
    concurrency: 50,
    connection: redis,
  },
)

partnerTelegramWorker.on('failed', async (job, err) => {
  console.error(`PARTNER TELEGRAM UPDATE: Ошибка в задаче ${job?.id}:`, err.message)
})

bot.launch({
  webhook: {
    domain: webhookUrl.hostname,
    path: webhookUrl.pathname,
  },
})

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
