// bot/src/payments/confirmPayment.ts

import { FmtString } from 'telegraf/format'
import { randomUUID } from 'crypto'
import { ReminderStatus, OfferStatus } from '@prisma/client'
import { prisma } from '../prisma'
import { actionsMessages } from '../config'
import { inline_keyboard_generate } from '../helpers/inline_keyboard_generate'
import { bot } from '../telegraf'
import { getAdmins } from '../helpers/getAdmins'
import { reminderQueue } from '../reminders/scheduler'

/**
 * Ручное подтверждение оплаты по Telegram ID пользователя.
 *
 * Используется командой админа: /paid <telegramId> <amount>
 *
 * Делает:
 * 1) Создаёт Payment (ручной платёж, без привязки к счёту WATA).
 * 2) Помечает пользователя как paid = true.
 * 3) Все активные OfferInstance пользователя -> статус PAID.
 * 4) Гасит все напоминания (ReminderSubscription + BullMQ jobs).
 * 5) Отправляет пользователю пользовательское соглашение (AGREE).
 * 6) Шлёт уведомление админам.
 */
export async function confirmPaymentAndNotify(telegramId: string, amount: number): Promise<void> {
  // 0. Ищем пользователя по telegramId
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, telegramId: true },
  })

  if (!user) {
    throw new Error(`Пользователь с telegramId=${telegramId} не найден`)
  }

  const now = new Date()
  const paymentId = randomUUID()

  // 1–3. В одной транзакции:
  //   - создаём payment
  //   - помечаем юзера как paid
  //   - все активные офферы делаем PAID
  await prisma.$transaction([
    prisma.payment.create({
      data: {
        id: paymentId,
        userId: user.id,
        amount,
        currency: 'RUB', // для ручных оплат считаем в RUB; при необходимости потом можно расширить
        status: 'PAID',
        paidAt: now,
      },
    }),

    prisma.user.update({
      where: { id: user.id },
      data: {
        paid: true,
      },
    }),

    prisma.offerInstance.updateMany({
      where: {
        userId: user.id,
        status: OfferStatus.ACTIVE,
      },
      data: {
        status: OfferStatus.PAID,
        finishedAt: now,
      },
    }),
  ])

  // 4. Гасим все напоминания и снимаем джобы из очереди
  try {
    const pendingReminders = await prisma.reminderSubscription.findMany({
      where: {
        userId: user.id,
        status: ReminderStatus.PENDING,
      },
      select: {
        id: true,
        bullJobId: true,
      },
    })

    await Promise.allSettled(
      pendingReminders.map(async (reminder) => {
        try {
          await prisma.reminderSubscription.update({
            where: { id: reminder.id },
            data: {
              status: ReminderStatus.CANCELED,
              canceledAt: now,
            },
          })

          if (reminder.bullJobId) {
            const job = await reminderQueue.getJob(reminder.bullJobId)
            if (job) {
              await job.remove()
            }
          }
        } catch (err) {
          console.error('Ошибка при отмене напоминания (ручная оплата):', reminder.id, err)
          throw err
        }
      })
    )
  } catch (err) {
    console.error(`Ошибка при отмене напоминаний для пользователя ${user.id}:`, err)
    // не бросаем дальше — оплата для юзера уже подтверждена
  }

  // 5. Отправляем пользователю пользовательское соглашение (AGREE)
  const { text, buttons } = actionsMessages.AGREE

  const results = await Promise.allSettled([
    bot.telegram.sendMessage(user.telegramId, new FmtString(text), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: inline_keyboard_generate(buttons),
      },
    }),

    // 6. Уведомление админам
    ...getAdmins().map((adminId) =>
      bot.telegram.sendMessage(
        adminId,
        `🦾 Ручная оплата (/paid)!\n` +
          `👤 telegramId: ${user.telegramId}\n` +
          `🆔 userId: ${user.id}\n` +
          `💰 Сумма: ${amount.toFixed(2)} ₽`,
        { parse_mode: 'HTML' }
      )
    ),
  ])

  results
    .filter((r) => r.status === 'rejected')
    .forEach((r) => {
      console.warn('⚠️  Ошибка при отправке сообщений после ручной оплаты:')
      console.warn(JSON.stringify(r, null, 2))
    })
}
