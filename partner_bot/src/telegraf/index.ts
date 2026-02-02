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
import { BASE_EARNING_RATE, formatMoney, formatPercent, parseAmount, parsePercent } from '../helpers/money'

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
const REF_PAGE_SIZE = 3
const WITHDRAW_PAGE_SIZE = 3
const MAIN_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME
const REF_CODE_REGEX = /^[A-Za-z0-9_-]{3,32}$/

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

const buildMainMenu = (admin: boolean, walletLabel: string, withdrawCount: number) => {
  const rows = [
    [Markup.button.callback('🔄 Обновить статистику', 'REFRESH_STATS')],
    [Markup.button.callback('🔗 Реф. ссылки', 'REF_LIST')],
    [Markup.button.callback(walletLabel, 'WALLET_SET')],
    [Markup.button.callback('💸 Запросить вывод', 'WITHDRAW_REQUEST')],
  ]

  if (admin) {
    const label = withdrawCount > 0 ? `🧾 Заявки на вывод (${withdrawCount})` : '🧾 Заявки на вывод'
    rows.push([Markup.button.callback(label, 'ADMIN_WITHDRAW_LIST')])
    rows.push([Markup.button.callback('📥 CSV выгрузка', 'ADMIN_EXPORT_CSV')])
    rows.push([Markup.button.callback('🧮 Изменить ставку реф. ссылки', 'ADMIN_RATE_REF')])
  }

  return Markup.inlineKeyboard(rows)
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

  const walletLine = partner.usdtWallet
    ? `👛 USDT кошелёк: ${escapeHtml(partner.usdtWallet)}`
    : '👛 USDT кошелёк: не указан'

  const text = [
    '⚙️ <b>Меню партнёра</b> ⚙️',
    `🔗 Реф. ссылок: ${stats.items.length}`,
    `✨ Уникальные пользователи: ${stats.totals.totalUsers}`,
    `💸 Заработано всего: ${formatMoney(stats.totals.totalEarnings)} ₽`,
    `🎉 <b>Доступно к выводу: ${formatMoney(stats.totals.available)} ₽</b>`,
    `⏳ В ожидании выплаты: ${formatMoney(stats.totals.pending)} ₽`,
    `💲 Выплачено: ${formatMoney(stats.totals.approved)} ₽`,
    walletLine,
  ].join('\n')

  const walletLabel = partner.usdtWallet ? '✏️ Изменить кошелёк' : '➕ Указать кошелёк'
  await clearListForUser(ctx)
  if (opts?.clearNotices) {
    await clearNoticesForUser(ctx)
  }
  await sendControlMessage(ctx, text, buildMainMenu(admin, walletLabel, withdrawCount))
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
      `✨ Уникальные пользователи: ${item.users}`,
      `💸 Заработано всего: ${formatMoney(item.earnings)} ₽`,
    ].join('\n')

    await sendControlMessage(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'REF_LIST')]]))
  }),
)

bot.action(
  'WALLET_SET',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await clearListForUser(ctx)
    const telegramId = String(ctx.from.id)
    const partner = await ensurePartner(telegramId)
    await setSession(telegramId, { action: 'SET_WALLET' })
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
  'WITHDRAW_REQUEST',
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
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'MAIN_MENU')]]),
      )
      return
    }

    if (stats.totals.available.lte(0)) {
      await sendControlMessage(
        ctx,
        'Сейчас нет доступного баланса для вывода.',
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'MAIN_MENU')]]),
      )
      return
    }

    await setSession(telegramId, { action: 'WITHDRAW_AMOUNT' })
    await sendControlMessage(
      ctx,
      `Введите сумму для вывода (доступно ${formatMoney(stats.totals.available)} ₽) или нажмите «Вывести всё».`,
      Markup.inlineKeyboard([
        [Markup.button.callback('💸 Вывести всё', 'WITHDRAW_ALL')],
        [Markup.button.callback('⬅️ Назад', 'MAIN_MENU')],
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
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'MAIN_MENU')]]),
      )
      return
    }

    if (stats.totals.available.lte(0)) {
      await sendControlMessage(
        ctx,
        'Сейчас нет доступного баланса для вывода.',
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'MAIN_MENU')]]),
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
        `Сумма: ${formatMoney(withdrawal.amount)} ₽`,
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
      'Введите ссылку на выплату в TronScan.',
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
      await sendMainMenu(ctx)
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

      const text = [
        `<b>Реф. ссылка:</b> ${escapeHtml(referral.name || referral.code)}`,
        `Код: ${escapeHtml(referral.code)}`,
        '',
        `Текущая ставка: ${formatPercent(currentRate)}%`,
        'Базовая ставка считается так: (100% - 11%) x 70% = 62.3%',
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
          `💸 Сумма: ${formatMoney(withdrawal.amount)} ₽`,
          `🔗 Ссылка на выплату: ${escapeHtml(linkText)}`,
          '<b>🔥 Ожидайте, выплата придёт в течении 5-30 минут!</b>',
        ].join('\n'),
        { parse_mode: 'HTML', link_preview_options: {
          is_disabled: true
        } },
      )

      return
    }
  }),
)

const createWithdrawalRequest = async (ctx: any, partner: any, amount: Prisma.Decimal) => {
  const telegramId = String(ctx.from.id)
  const stats = await getPartnerStats(partner.id)
  const normalizedAmount = new Prisma.Decimal(Math.floor(amount.toNumber()))
  if (normalizedAmount.lte(0)) {
    await sendNotice(ctx, 'Сумма должна быть больше 0.')
    return
  }

  if (normalizedAmount.gt(stats.totals.available)) {
    await sendNotice(ctx, `Сумма превышает доступный баланс (${formatMoney(stats.totals.available)} ₽).`)
    return
  }

  const withdrawal = await prisma.partnerWithdrawal.create({
    data: {
      partnerId: partner.id,
      amount: normalizedAmount,
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
      `Сумма: ${formatMoney(withdrawal.amount)} ₽`,
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
