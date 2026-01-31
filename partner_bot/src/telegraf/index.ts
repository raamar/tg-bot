import { Telegraf, Markup } from 'telegraf'
import type { Update } from 'telegraf/typings/core/types/typegram'
import telegrafThrottler from 'telegraf-throttler'
import { Worker, Job } from 'bullmq'
import { Prisma, PartnerWithdrawalStatus } from '@app/db'
import path from 'path'

import { redis } from '../redis'
import { prisma } from '../prisma'
import { isAdmin } from '../helpers/isAdmin'
import { clearSession, getSession, setSession } from '../helpers/session'
import { exportPartnerRefsCsvToTempFile } from '../helpers/exportPartnerRefsCsv'
import { uploadReceiptToS3 } from '../s3'

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

const EARNING_RATE = new Prisma.Decimal('0.623')
const REF_PREFIX = 'ref'
const REF_LIMIT = 10
const MAIN_BOT_USERNAME = process.env.MAIN_BOT_USERNAME

const formatMoney = (value: Prisma.Decimal | number): string => {
  const num = typeof value === 'number' ? value : value.toNumber()
  return num.toFixed(2)
}

const parseAmount = (text: string): number | null => {
  const normalized = text.replace(',', '.').replace(/\s+/g, '')
  const value = Number.parseFloat(normalized)
  if (!Number.isFinite(value) || value <= 0) return null
  return value
}

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
  if (!MAIN_BOT_USERNAME) return `Код для /start: ${code}`
  return `https://t.me/${MAIN_BOT_USERNAME}?start=${code}`
}

const generateReferralCode = async (): Promise<string> => {
  for (let i = 0; i < 5; i += 1) {
    const random = Math.floor(Math.random() * 0xffffff)
    const hex = random.toString(16).padStart(6, '0').toUpperCase()
    const code = `${REF_PREFIX}${hex}`
    const exists = await prisma.partnerReferral.findUnique({
      where: { code },
      select: { id: true },
    })
    if (!exists) return code
  }
  throw new Error('Не удалось сгенерировать уникальную рефку')
}

const buildMainMenu = (admin: boolean) => {
  const rows = [
    [Markup.button.callback('🔗 Мои рефки', 'REF_LIST')],
    [Markup.button.callback('📊 Статистика', 'STATS_TOTAL')],
    [Markup.button.callback('💼 USDT кошелёк', 'WALLET_SET')],
    [Markup.button.callback('💸 Запросить вывод', 'WITHDRAW_REQUEST')],
  ]

  if (admin) {
    rows.push([Markup.button.callback('🧾 Заявки на вывод', 'ADMIN_WITHDRAW_LIST')])
    rows.push([Markup.button.callback('📥 CSV выгрузка', 'ADMIN_EXPORT_CSV')])
  }

  return Markup.inlineKeyboard(rows)
}

const getPartnerStats = async (partnerId: string) => {
  const referrals = await prisma.partnerReferral.findMany({
    where: { partnerId },
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

  const items = referrals.map((ref) => {
    const totalPaid = paidByRef.get(ref.code) ?? new Prisma.Decimal(0)
    const earnings = totalPaid.mul(EARNING_RATE)
    return {
      referral: ref,
      users: countsByRef.get(ref.code) ?? 0,
      totalPaid,
      earnings,
    }
  })

  const totalEarnings = items.reduce((acc, item) => acc.add(item.earnings), new Prisma.Decimal(0))

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
      approved,
      pending,
      available,
    },
  }
}

const sendMainMenu = async (ctx: any) => {
  const admin = isAdmin(ctx.from?.id)
  await ctx.reply('Меню партнёра:', buildMainMenu(admin))
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
    await sendMainMenu(ctx)
  }),
)

bot.action(
  'MAIN_MENU',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await sendMainMenu(ctx)
  }),
)

bot.action(
  'REF_LIST',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    const telegramId = String(ctx.from.id)
    const partner = await ensurePartner(telegramId)

    const refs = await prisma.partnerReferral.findMany({
      where: { partnerId: partner.id },
      orderBy: { createdAt: 'asc' },
    })

    const buttons: ReturnType<typeof Markup.button.callback>[] = []
    refs.forEach((ref) => {
      buttons.push(Markup.button.callback(`📌 ${ref.name || ref.code}`, `REF_STATS:${ref.id}`))
      buttons.push(Markup.button.callback('✏️ Переименовать', `REF_RENAME:${ref.id}`))
    })

    if (refs.length < REF_LIMIT) {
      buttons.push(Markup.button.callback('➕ Создать рефку', 'REF_CREATE'))
    }

    buttons.push(Markup.button.callback('⬅️ Назад', 'MAIN_MENU'))

    const rows: any[] = []
    for (let i = 0; i < buttons.length; i += 2) {
      rows.push(buttons.slice(i, i + 2))
    }

    if (!refs.length) {
      await ctx.reply('У вас пока нет рефок. Создайте первую.', Markup.inlineKeyboard(rows))
      return
    }

    const listText = refs
      .map(
        (ref, idx) =>
          `${idx + 1}. ${ref.name || ref.code} (${ref.code})\n${buildRefLink(ref.code)}`,
      )
      .join('\n')

    await ctx.reply(`Ваши рефки:\n\n${listText}`, Markup.inlineKeyboard(rows))
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
      await ctx.reply(`Максимум ${REF_LIMIT} рефок.`)
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
    await ctx.reply(
      `Рефка создана: ${code}\n${buildRefLink(code)}\nВведите название для удобства или отправьте /skip.`,
    )
  }),
)

bot.action(
  /^REF_RENAME:(.+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    const referralId = ctx.match[1]
    const telegramId = String(ctx.from.id)

    await setSession(telegramId, { action: 'REF_NAME_EDIT', referralId })
    await ctx.reply('Введите новое название рефки (или /skip для сброса).')
  }),
)

bot.action(
  /^REF_STATS:(.+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    const referralId = ctx.match[1]
    const telegramId = String(ctx.from.id)
    const partner = await ensurePartner(telegramId)

    const referral = await prisma.partnerReferral.findFirst({
      where: { id: referralId, partnerId: partner.id },
    })

    if (!referral) {
      await ctx.reply('Рефка не найдена.')
      return
    }

    const stats = await getPartnerStats(partner.id)
    const item = stats.items.find((it) => it.referral.id === referral.id)

    if (!item) {
      await ctx.reply('Статистика недоступна.')
      return
    }

    const text = [
      `Рефка: ${referral.name || referral.code}`,
      `Код: ${referral.code}`,
      buildRefLink(referral.code),
      `Уникальные пользователи: ${item.users}`,
      `Общая сумма оплат: ${formatMoney(item.totalPaid)} RUB`,
      `Заработок партнёра: ${formatMoney(item.earnings)} RUB`,
    ].join('\n')

    await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'REF_LIST')]]))
  }),
)

bot.action(
  'STATS_TOTAL',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    const telegramId = String(ctx.from.id)
    const partner = await ensurePartner(telegramId)

    const stats = await getPartnerStats(partner.id)

    const totalText = [
      '📊 Общая статистика',
      `Рефок: ${stats.items.length}`,
      `Заработано всего: ${formatMoney(stats.totals.totalEarnings)} RUB`,
      `В ожидании: ${formatMoney(stats.totals.pending)} RUB`,
      `Выплачено: ${formatMoney(stats.totals.approved)} RUB`,
      `Доступно к выводу: ${formatMoney(stats.totals.available)} RUB`,
    ].join('\n')

    await ctx.reply(totalText, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'MAIN_MENU')]]))
  }),
)

bot.action(
  'WALLET_SET',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    const telegramId = String(ctx.from.id)
    const partner = await ensurePartner(telegramId)
    await setSession(telegramId, { action: 'SET_WALLET' })
    const current = partner.usdtWallet ? `Текущий: ${partner.usdtWallet}\n` : ''
    await ctx.reply(`${current}Введите ваш USDT кошелёк (текст).`)
  }),
)

bot.action(
  'WITHDRAW_REQUEST',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    const telegramId = String(ctx.from.id)
    const partner = await ensurePartner(telegramId)
    const stats = await getPartnerStats(partner.id)

    if (stats.totals.available.lte(0)) {
      await ctx.reply('Сейчас нет доступного баланса для вывода.')
      return
    }

    await setSession(telegramId, { action: 'WITHDRAW_AMOUNT' })
    await ctx.reply(
      `Введите сумму для вывода (доступно ${formatMoney(stats.totals.available)} RUB).`,
    )
  }),
)

bot.action(
  'ADMIN_WITHDRAW_LIST',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})

    if (!isAdmin(ctx.from?.id)) {
      await ctx.reply('Недостаточно прав.')
      return
    }

    const withdrawals = await prisma.partnerWithdrawal.findMany({
      where: { status: PartnerWithdrawalStatus.IN_REVIEW },
      include: { partner: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    })

    if (!withdrawals.length) {
      await ctx.reply('Нет заявок в работе.')
      return
    }

    for (const withdrawal of withdrawals) {
      const text = [
        `Заявка: ${withdrawal.id}`,
        `Партнёр: ${withdrawal.partner.username || withdrawal.partner.telegramId}`,
        `Telegram ID: ${withdrawal.partner.telegramId}`,
        `Кошелёк: ${withdrawal.partner.usdtWallet || 'не указан'}`,
        `Сумма: ${formatMoney(withdrawal.amount)} RUB`,
      ].join('\n')

      await ctx.reply(
        text,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Одобрить', `ADMIN_APPROVE:${withdrawal.id}`),
            Markup.button.callback('❌ Отклонить', `ADMIN_REJECT:${withdrawal.id}`),
          ],
        ]),
      )
    }
  }),
)

bot.action(
  'ADMIN_EXPORT_CSV',
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})

    if (!isAdmin(ctx.from?.id)) {
      await ctx.reply('Недостаточно прав.')
      return
    }

    const { filePath, filename, rows } = await exportPartnerRefsCsvToTempFile(prisma)

    if (!rows) {
      await ctx.reply('Нет данных для выгрузки.')
      return
    }

    await ctx.replyWithDocument({ source: filePath, filename })
  }),
)

bot.action(
  /^ADMIN_APPROVE:(.+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})

    if (!isAdmin(ctx.from?.id)) {
      await ctx.reply('Недостаточно прав.')
      return
    }

    const withdrawalId = ctx.match[1]
    await setSession(String(ctx.from.id), { action: 'ADMIN_APPROVE_RECEIPT', withdrawalId })
    await ctx.reply('Отправьте скрин подтверждения (фото или файл).')
  }),
)

bot.action(
  /^ADMIN_REJECT:(.+)$/,
  withErrorHandling(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})

    if (!isAdmin(ctx.from?.id)) {
      await ctx.reply('Недостаточно прав.')
      return
    }

    const withdrawalId = ctx.match[1]
    await setSession(String(ctx.from.id), { action: 'ADMIN_REJECT_REASON', withdrawalId })
    await ctx.reply('Введите причину отклонения.')
  }),
)

bot.on(
  'message',
  withErrorHandling(async (ctx) => {
    const telegramId = String(ctx.from.id)
    const session = await getSession(telegramId)

    if (!session) {
      await ctx.reply('Используйте меню /start.')
      return
    }

    if (session.action === 'SET_WALLET') {
      const wallet = ctx.message?.text
      if (!wallet) {
        await ctx.reply('Нужен текстовый кошелёк.')
        return
      }
      await prisma.partner.update({
        where: { telegramId },
        data: { usdtWallet: wallet.trim() },
      })
      await clearSession(telegramId)
      await ctx.reply('Кошелёк сохранён.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'MAIN_MENU')]]))
      return
    }

    if (session.action === 'REF_NAME_CREATE' || session.action === 'REF_NAME_EDIT') {
      const nameText = ctx.message?.text
      if (!nameText) {
        await ctx.reply('Введите текстовое название.')
        return
      }
      const name = nameText.trim()
      const finalName = name === '/skip' ? null : name

      await prisma.partnerReferral.update({
        where: { id: session.referralId },
        data: { name: finalName || null },
      })
      await clearSession(telegramId)
      await ctx.reply('Название сохранено.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'REF_LIST')]]))
      return
    }

    if (session.action === 'WITHDRAW_AMOUNT') {
      const text = ctx.message?.text
      if (!text) {
        await ctx.reply('Введите сумму цифрами.')
        return
      }

      const amount = parseAmount(text)
      if (!amount) {
        await ctx.reply('Неверная сумма. Попробуйте снова.')
        return
      }

      const partner = await prisma.partner.findUnique({ where: { telegramId } })
      if (!partner) {
        await ctx.reply('Партнёр не найден.')
        await clearSession(telegramId)
        return
      }

      const stats = await getPartnerStats(partner.id)
      if (new Prisma.Decimal(amount).gt(stats.totals.available)) {
        await ctx.reply(`Сумма превышает доступный баланс (${formatMoney(stats.totals.available)} RUB).`)
        return
      }

      const withdrawal = await prisma.partnerWithdrawal.create({
        data: {
          partnerId: partner.id,
          amount: new Prisma.Decimal(amount),
          status: PartnerWithdrawalStatus.IN_REVIEW,
        },
      })

      await clearSession(telegramId)
      await ctx.reply('Заявка создана и отправлена на проверку.')

      const admins = process.env.ADMIN_IDS?.split(',').map(Number).filter(Boolean) || []
      if (admins.length) {
        const text = [
          '🧾 Новая заявка на вывод',
          `ID: ${withdrawal.id}`,
          `Партнёр: ${partner.username || partner.telegramId}`,
          `Сумма: ${formatMoney(withdrawal.amount)} RUB`,
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

      return
    }

    if (session.action === 'ADMIN_REJECT_REASON') {
      if (!isAdmin(ctx.from?.id)) {
        await ctx.reply('Недостаточно прав.')
        await clearSession(telegramId)
        return
      }

      const reason = ctx.message?.text?.trim()
      if (!reason) {
        await ctx.reply('Нужна причина отклонения.')
        return
      }

      const withdrawal = await prisma.partnerWithdrawal.findUnique({
        where: { id: session.withdrawalId },
        include: { partner: true },
      })

      if (!withdrawal || withdrawal.status !== PartnerWithdrawalStatus.IN_REVIEW) {
        await ctx.reply('Заявка недоступна для отклонения.')
        await clearSession(telegramId)
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
      await ctx.reply('Заявка отклонена.')

      await bot.telegram.sendMessage(
        withdrawal.partner.telegramId,
        `❌ Ваша заявка на вывод отклонена. Причина: ${reason}`,
      )

      return
    }

    if (session.action === 'ADMIN_APPROVE_RECEIPT') {
      if (!isAdmin(ctx.from?.id)) {
        await ctx.reply('Недостаточно прав.')
        await clearSession(telegramId)
        return
      }

      const withdrawal = await prisma.partnerWithdrawal.findUnique({
        where: { id: session.withdrawalId },
        include: { partner: true },
      })

      if (!withdrawal || withdrawal.status !== PartnerWithdrawalStatus.IN_REVIEW) {
        await ctx.reply('Заявка недоступна для подтверждения.')
        await clearSession(telegramId)
        return
      }

      const message: any = ctx.message
      const photo = message?.photo?.[message.photo.length - 1]
      const document = message?.document
      const fileId = photo?.file_id || document?.file_id

      if (!fileId) {
        await ctx.reply('Нужен файл или фото скрина.')
        return
      }

      const file = await bot.telegram.getFile(fileId)
      const filePath = file.file_path || ''
      const ext = path.extname(filePath) || '.jpg'
      const link = await bot.telegram.getFileLink(fileId)
      const res = await fetch(link.href)
      const buffer = Buffer.from(await res.arrayBuffer())
      const contentType = res.headers.get('content-type') || undefined

      const key = `receipts/${withdrawal.partnerId}/${withdrawal.id}${ext}`
      const receiptUrl = await uploadReceiptToS3(key, buffer, contentType)

      await prisma.partnerWithdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: PartnerWithdrawalStatus.APPROVED,
          receiptUrl,
          receiptKey: key,
          decidedAt: new Date(),
        },
      })

      await clearSession(telegramId)
      await ctx.reply('Заявка подтверждена.')

      await bot.telegram.sendMessage(
        withdrawal.partner.telegramId,
        `✅ Ваша заявка на вывод одобрена. Сумма: ${formatMoney(withdrawal.amount)} RUB`,
      )
      await bot.telegram.sendPhoto(withdrawal.partner.telegramId, { source: buffer })

      return
    }
  }),
)

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
