import { Telegraf, Markup } from 'telegraf'
import type { Update } from 'telegraf/typings/core/types/typegram'
import telegrafThrottler from 'telegraf-throttler'
import { Worker, Job } from 'bullmq'
import { RecruitPartnerWithdrawalStatus, Prisma } from '@app/db'

import { redis } from '../redis'
import { prisma } from '../prisma'
import { isAdmin } from '../helpers/isAdmin'
import { clearSession, getSession, setSession } from '../helpers/session'
import { getMenuMessage, setMenuMessage } from '../helpers/menuMessage'
import { clearListMessages, getListMessages, pushListMessage } from '../helpers/listMessages'
import { clearNoticeMessages, getNoticeMessages, pushNoticeMessage } from '../helpers/noticeMessages'
import { formatCountUi, formatMoneyUi, parseAmount } from '../helpers/money'

if (process.env.TELEGRAM_TOKEN_3 === undefined) {
  throw new Error('TELEGRAM_TOKEN_3 is not defined')
}

if (process.env.TELEGRAM_WEBHOOK_URL_3 === undefined) {
  throw new Error('TELEGRAM_WEBHOOK_URL_3 is not defined')
}

export const bot = new Telegraf(process.env.TELEGRAM_TOKEN_3)
const webhookUrl = new URL(process.env.TELEGRAM_WEBHOOK_URL_3)

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
const QUALIFIED_PARTNER_BONUS = new Prisma.Decimal(5000)
const PARTNER_BOT_USERNAME = process.env.TELEGRAM_PARTNER_BOT_USERNAME
const REF_CODE_REGEX = /^[A-Za-z0-9_-]{3,32}$/
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

type AnalyticsType = 'DAY' | 'WEEK' | 'MONTH'
const ANALYTICS_DEFAULT_TYPE: AnalyticsType = 'WEEK'

const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const ensurePartner = async (telegramId: string, username?: string, firstName?: string, lastName?: string) => {
  return prisma.recruitPartner.upsert({
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
  if (!PARTNER_BOT_USERNAME) return `https://t.me/USERNAME?start=${code}`
  return `https://t.me/${PARTNER_BOT_USERNAME}?start=${code}`
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
    const exists = await prisma.recruitPartnerReferral.findUnique({
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
    [Markup.button.callback('📊 Аналитика', 'ANALYTICS')],
    [Markup.button.callback('💸 Запросить вывод', 'WITHDRAW_REQUEST')],
  ]

  if (admin) {
    const label = withdrawCount > 0 ? `🧾 Заявки на вывод (${withdrawCount})` : '🧾 Заявки на вывод'
    rows.push([Markup.button.callback('🏆 ТОП партнёров', 'TOP_PARTNERS')])
    rows.push([Markup.button.callback(label, 'ADMIN_WITHDRAW_LIST')])
  }

  rows.push([Markup.button.url('ℹ️ Подробнее о проекте', 'https://t.me/only_noref')])

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

const getPartnerStats = async (partnerId: string) => {
  const referrals = await prisma.recruitPartnerReferral.findMany({
    where: { partnerId },
    orderBy: { createdAt: 'asc' },
  })

  const refIds = referrals.map((ref) => ref.id)

  const invitedPartners =
    refIds.length === 0
      ? []
      : await prisma.partner.findMany({
          where: { recruitReferralId: { in: refIds } },
          select: { id: true, recruitReferralId: true },
        })

  const invitedCountByRefId = new Map<string, number>()
  invitedPartners.forEach((partner) => {
    if (!partner.recruitReferralId) return
    invitedCountByRefId.set(partner.recruitReferralId, (invitedCountByRefId.get(partner.recruitReferralId) ?? 0) + 1)
  })

  const qualifications = await prisma.recruitPartnerQualification.findMany({
    where: { recruitPartnerId: partnerId },
    select: { recruitReferralId: true },
  })

  const qualifiedCountByRefId = new Map<string, number>()
  qualifications.forEach((q) => {
    qualifiedCountByRefId.set(q.recruitReferralId, (qualifiedCountByRefId.get(q.recruitReferralId) ?? 0) + 1)
  })

  const items = referrals.map((ref) => {
    const invited = invitedCountByRefId.get(ref.id) ?? 0
    const qualified = qualifiedCountByRefId.get(ref.id) ?? 0
    const earnings = QUALIFIED_PARTNER_BONUS.mul(qualified)

    return {
      referral: ref,
      invited,
      qualified,
      earnings,
    }
  })

  const totalInvited = items.reduce((acc, item) => acc + item.invited, 0)
  const totalQualified = items.reduce((acc, item) => acc + item.qualified, 0)
  const totalEarnings = QUALIFIED_PARTNER_BONUS.mul(totalQualified)

  const withdrawals = await prisma.recruitPartnerWithdrawal.groupBy({
    by: ['status'],
    where: { partnerId },
    _sum: { amount: true },
  })

  let approved = new Prisma.Decimal(0)
  let pending = new Prisma.Decimal(0)

  withdrawals.forEach((row) => {
    const amount = row._sum.amount ?? new Prisma.Decimal(0)
    if (row.status === RecruitPartnerWithdrawalStatus.APPROVED) approved = amount
    if (row.status === RecruitPartnerWithdrawalStatus.IN_REVIEW) pending = amount
  })

  let available = totalEarnings.sub(approved).sub(pending)
  if (available.isNegative()) available = new Prisma.Decimal(0)

  return {
    items,
    totals: {
      totalInvited,
      totalQualified,
      totalEarnings,
      approved,
      pending,
      available,
    },
  }
}

const getPartnerPeriodStats = async (
  partnerId: string,
  startUtc: Date,
  endUtc: Date,
): Promise<{ invited: number; qualified: number; earnings: Prisma.Decimal }> => {
  const invited = await prisma.partner.count({
    where: {
      recruitReferral: { partnerId },
      createdAt: { gte: startUtc, lt: endUtc },
    },
  })

  const qualified = await prisma.recruitPartnerQualification.count({
    where: {
      recruitPartnerId: partnerId,
      qualifiedAt: { gte: startUtc, lt: endUtc },
    },
  })

  const earnings = QUALIFIED_PARTNER_BONUS.mul(qualified)
  return { invited, qualified, earnings }
}

const getReferralPeriodStats = async (
  referralId: string,
  startUtc: Date,
  endUtc: Date,
): Promise<{ invited: number; qualified: number; earnings: Prisma.Decimal }> => {
  const invited = await prisma.partner.count({
    where: {
      recruitReferralId: referralId,
      createdAt: { gte: startUtc, lt: endUtc },
    },
  })

  const qualified = await prisma.recruitPartnerQualification.count({
    where: {
      recruitReferralId: referralId,
      qualifiedAt: { gte: startUtc, lt: endUtc },
    },
  })

  const earnings = QUALIFIED_PARTNER_BONUS.mul(qualified)
  return { invited, qualified, earnings }
}

const getHasPrevPeriod = async (partnerId: string, type: AnalyticsType, startMskMs: number): Promise<boolean> => {
  const earliestInvited = await prisma.partner.aggregate({
    where: { recruitReferral: { partnerId } },
    _min: { createdAt: true },
  })

  const earliestQualified = await prisma.recruitPartnerQualification.aggregate({
    where: { recruitPartnerId: partnerId },
    _min: { qualifiedAt: true },
  })

  const invitedAt = earliestInvited._min.createdAt
  const qualifiedAt = earliestQualified._min.qualifiedAt

  let earliestDate: Date | null = null
  if (invitedAt && qualifiedAt) {
    earliestDate = invitedAt < qualifiedAt ? invitedAt : qualifiedAt
  } else {
    earliestDate = invitedAt ?? qualifiedAt ?? null
  }

  if (!earliestDate) return false

  const earliestStartMskMs = getPeriodStartMskMsForUtc(earliestDate, type)
  return startMskMs > earliestStartMskMs
}

const sendTopPartners = async (ctx: any) => {
  const top = await prisma.recruitPartner.findMany({
    include: {
      _count: {
        select: { qualifications: true },
      },
    },
  })

  const sorted = top
    .map((item) => ({
      ...item,
      qualifiedCount: item._count.qualifications,
      earnings: QUALIFIED_PARTNER_BONUS.mul(item._count.qualifications),
    }))
    .sort((a, b) => b.qualifiedCount - a.qualifiedCount)
    .slice(0, 10)

  const rows = ['🏆 <b>ТОП партнёров</b>', 'По количеству квалифицированных траферов', '']

  if (!sorted.length) {
    rows.push('Пока нет данных.')
  } else {
    sorted.forEach((item, index) => {
      const label = item.username || item.telegramId
      rows.push(
        `${index + 1}. ${escapeHtml(String(label))} — ${formatCountUi(item.qualifiedCount)} квалиф. / ${formatMoneyUi(item.earnings)} ₽`,
      )
    })
  }

  await clearListForUser(ctx)
  await sendControlMessage(
    ctx,
    rows.join('\n'),
    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'MAIN_MENU')]]),
  )
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
  const telegramId = String(ctx.from.id)
  const partner = await ensurePartner(telegramId)
  const { startUtc, endUtc, startMskMs, label } = getPeriodRange(type, offset)

  const stats = await getPartnerPeriodStats(partner.id, startUtc, endUtc)
  const hasPrev = await getHasPrevPeriod(partner.id, type, startMskMs)
  const hasNext = offset < 0

  const textRows = [
    '📊 <b>Аналитика</b>',
    `Период: ${escapeHtml(label)}`,
    '',
    `👥 Приглашено траферов: ${formatCountUi(stats.invited)}`,
    `✅ Квалифицировано траферов: ${formatCountUi(stats.qualified)}`,
    `💸 Начислено: ${formatMoneyUi(stats.earnings)} ₽`,
  ]

  await clearListForUser(ctx)
  await sendControlMessage(ctx, textRows.join('\n'), buildAnalyticsKeyboard(type, offset, hasPrev, hasNext))
}

const sendRefAnalytics = async (ctx: any, referral: any, type: AnalyticsType, offset: number) => {
  const telegramId = String(ctx.from.id)
  await ensurePartner(telegramId)

  const { startUtc, endUtc, startMskMs, label } = getPeriodRange(type, offset)
  const stats = await getReferralPeriodStats(referral.id, startUtc, endUtc)

  const earliestInvited = await prisma.partner.aggregate({
    where: { recruitReferralId: referral.id },
    _min: { createdAt: true },
  })
  const earliestQualified = await prisma.recruitPartnerQualification.aggregate({
    where: { recruitReferralId: referral.id },
    _min: { qualifiedAt: true },
  })

  const invitedAt = earliestInvited._min.createdAt
  const qualifiedAt = earliestQualified._min.qualifiedAt
  let earliestDate: Date | null = null
  if (invitedAt && qualifiedAt) {
    earliestDate = invitedAt < qualifiedAt ? invitedAt : qualifiedAt
  } else {
    earliestDate = invitedAt ?? qualifiedAt ?? null
  }

  const hasPrev = earliestDate ? startMskMs > getPeriodStartMskMsForUtc(earliestDate, type) : false
  const hasNext = offset < 0

  const title = referral.name ? `${referral.name} (${referral.code})` : referral.code
  const rows = [
    '📊 <b>Аналитика реф. ссылки</b>',
    `${escapeHtml(title)}`,
    `Период: ${escapeHtml(label)}`,
    '',
    `👥 Приглашено траферов: ${formatCountUi(stats.invited)}`,
    `✅ Квалифицировано траферов: ${formatCountUi(stats.qualified)}`,
    `💸 Начислено: ${formatMoneyUi(stats.earnings)} ₽`,
  ]

  const keyboard = buildAnalyticsKeyboard(type, offset, hasPrev, hasNext)
  const keyboardRows = [...(keyboard.reply_markup?.inline_keyboard ?? [])]
  keyboardRows.push([Markup.button.callback('⬅️ К реф. ссылке', `REF_STATS:${referral.id}`)])

  await clearListForUser(ctx)
  await sendControlMessage(ctx, rows.join('\n'), Markup.inlineKeyboard(keyboardRows))
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
      await bot.telegram.deleteMessage(existing.chatId, existing.messageId)
    } catch {
      // ignore
    }
  }

  const sent = await ctx.reply(text, payload)
  await setMenuMessage(telegramId, { chatId: sent.chat.id, messageId: sent.message_id })
}

const clearListForUser = async (ctx: any): Promise<void> => {
  const telegramId = String(ctx.from.id)
  const list = await getListMessages(telegramId)
  if (!list.length) return

  await Promise.allSettled(
    list.map((item) =>
      bot.telegram.deleteMessage(item.chatId, item.messageId).catch(() => {
        // ignore
      }),
    ),
  )

  await clearListMessages(telegramId)
}

const clearNoticesForUser = async (ctx: any): Promise<void> => {
  const telegramId = String(ctx.from.id)
  const list = await getNoticeMessages(telegramId)
  if (!list.length) return

  await Promise.allSettled(
    list.map((item) =>
      bot.telegram.deleteMessage(item.chatId, item.messageId).catch(() => {
        // ignore
      }),
    ),
  )

  await clearNoticeMessages(telegramId)
}

const sendNotice = async (ctx: any, text: string): Promise<void> => {
  const telegramId = String(ctx.from.id)
  const sent = await ctx.reply(text)
  await pushNoticeMessage(telegramId, { chatId: sent.chat.id, messageId: sent.message_id })
}

const deleteUserMessage = async (ctx: any): Promise<void> => {
  try {
    const message = ctx.message
    if (!message?.message_id || !message?.chat?.id) return
    await bot.telegram.deleteMessage(message.chat.id, message.message_id)
  } catch {
    // ignore
  }
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
    ? await prisma.recruitPartnerWithdrawal.count({ where: { status: RecruitPartnerWithdrawalStatus.IN_REVIEW } })
    : 0

  const walletLine = partner.usdtWallet
    ? `👛 USDT кошелёк: ${escapeHtml(partner.usdtWallet)}`
    : '👛 USDT кошелёк: не указан'

  const textRows = [
    '⚙️ <b>Меню партнёра</b> ⚙️\n',
    `🔗 Реф. ссылок: ${formatCountUi(stats.items.length)}`,
    `👥 Приглашено траферов: ${formatCountUi(stats.totals.totalInvited)}`,
    `✅ Квалифицировано траферов: ${formatCountUi(stats.totals.totalQualified)}`,
    `💸 Начислено: ${formatMoneyUi(stats.totals.totalEarnings)} ₽`,
    `🎉 <b>Доступно к выводу: ${formatMoneyUi(stats.totals.available)} ₽</b>`,
    `⏳ В ожидании выплаты: ${formatMoneyUi(stats.totals.pending)} ₽`,
    `💲 Выплачено: ${formatMoneyUi(stats.totals.approved)} ₽`,
    walletLine,
  ]

  await clearListForUser(ctx)
  if (opts?.clearNotices) {
    await clearNoticesForUser(ctx)
  }
  await sendControlMessage(ctx, textRows.join('\n'), buildMainMenu(admin, withdrawCount))
}

const sendWithdrawRequestMenu = async (ctx: any) => {
  await clearListForUser(ctx)
  const telegramId = String(ctx.from.id)
  const partner = await ensurePartner(telegramId)
  const stats = await getPartnerStats(partner.id)
  const pendingCount = await prisma.recruitPartnerWithdrawal.count({
    where: { partnerId: partner.id, status: RecruitPartnerWithdrawalStatus.IN_REVIEW },
  })

  const menu = buildWithdrawMenu(partner, stats.totals.available, pendingCount)
  await sendControlMessage(ctx, menu.text, menu.keyboard)
}

const sendRefList = async (ctx: any, page = 1): Promise<void> => {
  const telegramId = String(ctx.from.id)
  const partner = await ensurePartner(telegramId)
  const refs = await prisma.recruitPartnerReferral.findMany({
    where: { partnerId: partner.id },
    orderBy: { createdAt: 'asc' },
  })

  const totalPages = Math.max(1, Math.ceil(refs.length / REF_PAGE_SIZE))
  const safePage = Math.min(Math.max(page, 1), totalPages)
  const start = (safePage - 1) * REF_PAGE_SIZE
  const pageRefs = refs.slice(start, start + REF_PAGE_SIZE)

  const rows: any[] = []
  const nav: any[] = []
  if (safePage > 1) nav.push(Markup.button.callback('⬅️', `REF_LIST:${safePage - 1}`))
  if (safePage < totalPages) nav.push(Markup.button.callback('➡️', `REF_LIST:${safePage + 1}`))

  if (nav.length) rows.push(nav)
  rows.push([Markup.button.callback('➕ Создать ссылку', 'REF_CREATE')])
  rows.push([Markup.button.callback('✍️ Указать код вручную', 'REF_CREATE_MANUAL')])
  rows.push([Markup.button.callback('⬅️ Назад', 'MAIN_MENU')])

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
    console.error('Recruit partner bot error:', message)
    await ctx.reply('Произошла ошибка, попробуйте позже.')
  }
}

bot.start(
  withErrorHandling(async (ctx) => {
    const from = ctx.from
    const telegramId = String(from?.id)
    await ensurePartner(telegramId, from?.username, from?.first_name, from?.last_name)
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
    if (!isAdmin(ctx.from?.id)) {
      await sendNotice(ctx, 'Недостаточно прав')
      await sendMainMenu(ctx)
      return
    }
    await sendTopPartners(ctx)
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
  /^ANALYTICS_TYPE:(DAY|WEEK|MONTH)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    const type = ctx.match[1] as AnalyticsType
    await sendAnalytics(ctx, type, 0)
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
    const rawPage = ctx.match?.[1]
    const page = Number.isFinite(Number(rawPage)) ? Number(rawPage) : 1
    await sendRefList(ctx, page)
  }),
)

bot.action(
  'REF_CREATE',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    const telegramId = String(ctx.from.id)
    const partner = await ensurePartner(telegramId)
    const count = await prisma.recruitPartnerReferral.count({ where: { partnerId: partner.id } })

    if (count >= REF_LIMIT) {
      await sendNotice(ctx, `Максимум ${REF_LIMIT} реф. ссылок`)
      await sendRefList(ctx)
      return
    }

    const code = await generateReferralCode()
    const referral = await prisma.recruitPartnerReferral.create({
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
    const telegramId = String(ctx.from.id)
    await setSession(telegramId, { action: 'REF_CREATE_MANUAL_CODE' })
    await sendControlMessage(
      ctx,
      '<b>Новая реф. ссылка</b>\nВведите код вручную (3-32 символа: буквы, цифры, _ или -).',
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'REF_LIST')]]),
    )
  }),
)

bot.action(
  /^REF_NAME_SKIP:([\w-]+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    await sendNotice(ctx, 'Название пропущено')
    await sendRefList(ctx)
  }),
)

bot.action(
  /^REF_RENAME:([\w-]+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    const telegramId = String(ctx.from.id)
    const referralId = ctx.match[1]
    await setSession(telegramId, { action: 'REF_NAME_EDIT', referralId })
    await sendControlMessage(
      ctx,
      '<b>Переименовать реф. ссылку</b>\nВведите новое название.',
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'REF_LIST')]]),
    )
  }),
)

bot.action(
  /^REF_STATS:([\w-]+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    const telegramId = String(ctx.from.id)
    const referralId = ctx.match[1]
    const partner = await ensurePartner(telegramId)

    const referral = await prisma.recruitPartnerReferral.findFirst({
      where: { id: referralId, partnerId: partner.id },
    })

    if (!referral) {
      await sendNotice(ctx, 'Реф. ссылка не найдена')
      await sendRefList(ctx)
      return
    }

    const invited = await prisma.partner.count({ where: { recruitReferralId: referral.id } })
    const qualified = await prisma.recruitPartnerQualification.count({ where: { recruitReferralId: referral.id } })
    const earnings = QUALIFIED_PARTNER_BONUS.mul(qualified)

    const text = [
      `<b>Реф. ссылка:</b> ${escapeHtml(referral.name || referral.code)}`,
      `Код: ${escapeHtml(referral.code)}`,
      formatCodeBlock(buildRefLink(referral.code)),
      '',
      `👥 Приглашено траферов: ${formatCountUi(invited)}`,
      `✅ Квалифицировано траферов: ${formatCountUi(qualified)}`,
      `💸 Начислено: ${formatMoneyUi(earnings)} ₽`,
    ].join('\n')

    await sendControlMessage(
      ctx,
      text,
      Markup.inlineKeyboard([
        [Markup.button.callback('📊 Аналитика', `RA:${referral.id}:${ANALYTICS_DEFAULT_TYPE}:0`)],
        [Markup.button.callback('⬅️ Назад', 'REF_LIST')],
      ]),
    )
  }),
)

bot.action(
  /^RA:([\w-]+):(DAY|WEEK|MONTH):(-?\d+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    const referralId = ctx.match[1]
    const type = ctx.match[2] as AnalyticsType
    const offset = Number(ctx.match[3])
    if (!Number.isFinite(offset)) {
      await sendRefList(ctx)
      return
    }
    const referral = await prisma.recruitPartnerReferral.findUnique({ where: { id: referralId } })
    if (!referral) {
      await sendNotice(ctx, 'Реф. ссылка не найдена')
      await sendRefList(ctx)
      return
    }
    await sendRefAnalytics(ctx, referral, type, offset)
  }),
)

bot.action(
  /^RA_TYPE:([\w-]+):(DAY|WEEK|MONTH)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    const referralId = ctx.match[1]
    const type = ctx.match[2] as AnalyticsType
    const referral = await prisma.recruitPartnerReferral.findUnique({ where: { id: referralId } })
    if (!referral) {
      await sendNotice(ctx, 'Реф. ссылка не найдена')
      await sendRefList(ctx)
      return
    }
    await sendRefAnalytics(ctx, referral, type, 0)
  }),
)

bot.action(
  /^RA_REFRESH:([\w-]+):(DAY|WEEK|MONTH):(-?\d+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearSession(String(ctx.from.id))
    const referralId = ctx.match[1]
    const type = ctx.match[2] as AnalyticsType
    const offset = Number(ctx.match[3])
    if (!Number.isFinite(offset)) {
      await sendRefList(ctx)
      return
    }
    const referral = await prisma.recruitPartnerReferral.findUnique({ where: { id: referralId } })
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
    const pendingCount = await prisma.recruitPartnerWithdrawal.count({
      where: { partnerId: partner.id, status: RecruitPartnerWithdrawalStatus.IN_REVIEW },
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
    const pendingCount = await prisma.recruitPartnerWithdrawal.count({
      where: { partnerId: partner.id, status: RecruitPartnerWithdrawalStatus.IN_REVIEW },
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

    if (!isAdmin(ctx.from?.id)) {
      await sendNotice(ctx, 'Недостаточно прав')
      await sendMainMenu(ctx)
      return
    }

    const rawPage = ctx.match?.[1]
    const page = Number.isFinite(Number(rawPage)) ? Number(rawPage) : 1
    const withdrawals = await prisma.recruitPartnerWithdrawal.findMany({
      where: { status: RecruitPartnerWithdrawalStatus.IN_REVIEW },
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

    await sendControlMessage(
      ctx,
      `<b>Заявки на вывод</b>\nСтраница ${safePage} из ${totalPages}`,
      Markup.inlineKeyboard(navRows),
    )
  }),
)

bot.action(
  /^ADMIN_APPROVE:([\w-]+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})

    if (!isAdmin(ctx.from?.id)) {
      await sendNotice(ctx, 'Недостаточно прав')
      await sendMainMenu(ctx)
      return
    }

    const withdrawalId = ctx.match[1]
    await setSession(String(ctx.from.id), { action: 'ADMIN_APPROVE_LINK', withdrawalId })
    await sendControlMessage(
      ctx,
      '<b>Подтверждение выплаты</b>\nВведите ссылку/txid подтверждения.',
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'ADMIN_WITHDRAW_LIST')]]),
    )
  }),
)

bot.action(
  /^ADMIN_REJECT:([\w-]+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})

    if (!isAdmin(ctx.from?.id)) {
      await sendNotice(ctx, 'Недостаточно прав')
      await sendMainMenu(ctx)
      return
    }

    const withdrawalId = ctx.match[1]
    await setSession(String(ctx.from.id), { action: 'ADMIN_REJECT_REASON', withdrawalId })
    await sendControlMessage(
      ctx,
      '<b>Отклонение заявки</b>\nВведите причину отклонения.',
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'ADMIN_WITHDRAW_LIST')]]),
    )
  }),
)

bot.on(
  'text',
  withErrorHandling(async (ctx) => {
    const telegramId = String(ctx.from.id)
    const session = await getSession(telegramId)
    if (!session) return

    if (session.action === 'REF_CREATE_MANUAL_CODE') {
      const codeText = ctx.message?.text?.trim().toUpperCase()
      if (!codeText) {
        await sendNotice(ctx, 'Введите код.')
        await deleteUserMessage(ctx)
        return
      }

      if (!REF_CODE_REGEX.test(codeText)) {
        await sendNotice(ctx, 'Неверный формат. Пример: A1B2C3')
        await deleteUserMessage(ctx)
        return
      }

      const exists = await prisma.recruitPartnerReferral.findUnique({ where: { code: codeText } })
      if (exists) {
        await sendNotice(ctx, 'Такой код уже существует.')
        await deleteUserMessage(ctx)
        return
      }

      const partner = await ensurePartner(telegramId)
      const count = await prisma.recruitPartnerReferral.count({ where: { partnerId: partner.id } })
      if (count >= REF_LIMIT) {
        await clearSession(telegramId)
        await sendNotice(ctx, `Максимум ${REF_LIMIT} реф. ссылок`)
        await sendRefList(ctx)
        return
      }

      const referral = await prisma.recruitPartnerReferral.create({
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
        Markup.inlineKeyboard([[Markup.button.callback('ОК', `REF_NAME_SKIP:${referral.id}`)]])
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
      await prisma.recruitPartner.update({
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

      await prisma.recruitPartnerReferral.update({
        where: { id: session.referralId },
        data: { name: nameText.trim() },
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

      const partner = await prisma.recruitPartner.findUnique({ where: { telegramId } })
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

    if (session.action === 'ADMIN_REJECT_REASON') {
      if (!isAdmin(ctx.from?.id)) {
        await clearSession(telegramId)
        await sendNotice(ctx, 'Недостаточно прав')
        await sendMainMenu(ctx)
        return
      }

      const reason = ctx.message?.text?.trim()
      if (!reason) {
        await sendNotice(ctx, 'Введите причину отклонения.')
        await deleteUserMessage(ctx)
        return
      }

      const withdrawal = await prisma.recruitPartnerWithdrawal.findUnique({
        where: { id: session.withdrawalId },
        include: { partner: true },
      })

      if (!withdrawal || withdrawal.status !== RecruitPartnerWithdrawalStatus.IN_REVIEW) {
        await clearSession(telegramId)
        await sendNotice(ctx, 'Заявка не найдена или уже обработана')
        await sendMainMenu(ctx)
        return
      }

      await prisma.recruitPartnerWithdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: RecruitPartnerWithdrawalStatus.REJECTED,
          reason,
          decidedAt: new Date(),
        },
      })

      await clearSession(telegramId)
      await sendNotice(ctx, 'Заявка отклонена')
      await sendMainMenu(ctx)
      await deleteUserMessage(ctx)

      await bot.telegram.sendMessage(withdrawal.partner.telegramId, `❌ Ваша заявка на вывод отклонена. Причина: ${reason}`)
      return
    }

    if (session.action === 'ADMIN_APPROVE_LINK') {
      if (!isAdmin(ctx.from?.id)) {
        await clearSession(telegramId)
        await sendNotice(ctx, 'Недостаточно прав')
        await sendMainMenu(ctx)
        return
      }

      const linkText = ctx.message?.text?.trim()
      if (!linkText) {
        await sendNotice(ctx, 'Введите ссылку/txid подтверждения.')
        await deleteUserMessage(ctx)
        return
      }

      const withdrawal = await prisma.recruitPartnerWithdrawal.findUnique({
        where: { id: session.withdrawalId },
        include: { partner: true },
      })

      if (!withdrawal || withdrawal.status !== RecruitPartnerWithdrawalStatus.IN_REVIEW) {
        await clearSession(telegramId)
        await sendNotice(ctx, 'Заявка не найдена или уже обработана')
        await sendMainMenu(ctx)
        return
      }

      await prisma.recruitPartnerWithdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: RecruitPartnerWithdrawalStatus.APPROVED,
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

  const withdrawal = await prisma.recruitPartnerWithdrawal.create({
    data: {
      partnerId: partner.id,
      amount: roundedAmount,
      status: RecruitPartnerWithdrawalStatus.IN_REVIEW,
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

const recruitTelegramWorker = new Worker<Update>(
  'telegram_bot3',
  async (job: Job<Update>) => {
    await bot.handleUpdate(job.data)
  },
  {
    concurrency: 50,
    connection: redis,
  },
)

recruitTelegramWorker.on('failed', async (job, err) => {
  console.error(`RECRUIT TELEGRAM UPDATE: Ошибка в задаче ${job?.id}:`, err.message)
})

bot.launch({
  webhook: {
    domain: webhookUrl.hostname,
    path: webhookUrl.pathname,
  },
})
