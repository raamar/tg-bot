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

type SimpleUser = {
  id: string
  telegramId: string
}

async function cancelRemindersForUser(userId: string, now: Date): Promise<void> {
  try {
    const pendingReminders = await prisma.reminderSubscription.findMany({
      where: {
        userId,
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
          console.error('Ошибка при отмене напоминания:', reminder.id, err)
          throw err
        }
      })
    )
  } catch (err) {
    console.error(`Ошибка при отмене напоминаний для пользователя ${userId}:`, err)
  }
}

async function sendAgreementAndNotifyAdmins(
  user: SimpleUser,
  amount: number,
  currency: string,
  adminPrefix: string
): Promise<void> {
  const { text, buttons } = actionsMessages.AGREE

  const results = await Promise.allSettled([
    // Сообщение пользователю с пользовательским соглашением
    bot.telegram.sendMessage(user.telegramId, new FmtString(text), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: inline_keyboard_generate(buttons),
      },
    }),

    // Уведомление админам
    ...getAdmins().map((adminId) =>
      bot.telegram.sendMessage(adminId, `${adminPrefix}\n` + `💰 Сумма: ${amount.toFixed(2)} ${currency}`, {
        parse_mode: 'HTML',
      })
    ),
  ])

  results
    .filter((r) => r.status === 'rejected')
    .forEach((r) => {
      console.warn('⚠️  Ошибка при отправке сообщений после оплаты:')
      console.warn(JSON.stringify(r, null, 2))
    })
}

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
export async function confirmPaymentAndNotify(telegramId: string, amount: number, skipNotify: boolean): Promise<void> {
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
        currency: 'RUB', // ручные оплаты считаем в RUB
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
  await cancelRemindersForUser(user.id, now)

  if (skipNotify) {
    return
  }
  // 5–6. Соглашение + уведомление админам
  await sendAgreementAndNotifyAdmins(user, amount, 'RUB', '🦾 Ручная оплата (/paid)!')
}

/**
 * Автоматическое подтверждение оплаты по ID платежа.
 *
 * Используется вебхуком (WATA / любая другая платёжка),
 * куда заранее передан Payment.id (например, в orderId/id).
 *
 * Делает:
 * 1) Обновляет существующий Payment -> PAID.
 * 2) Помечает пользователя как paid = true.
 * 3) Все активные OfferInstance пользователя -> статус PAID.
 * 4) Гасит все напоминания (ReminderSubscription + BullMQ jobs).
 * 5) Отправляет пользователю пользовательское соглашение (AGREE).
 * 6) Шлёт уведомление админам.
 */
export async function confirmPayment(paymentId: string): Promise<void> {
  const now = new Date()

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      user: true,
    },
  })

  if (!payment) {
    throw new Error(`Платёж с id=${paymentId} не найден`)
  }

  // идемпотентность: если уже PAID — выходим
  if (payment.status === 'PAID') {
    return
  }

  // Обновляем платёж и помечаем пользователя как paid
  const updatedPayment = await prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: 'PAID',
      paidAt: now,
      user: {
        update: {
          paid: true,
        },
      },
    },
    include: {
      user: true,
    },
  })

  const user: SimpleUser = {
    id: updatedPayment.user.id,
    telegramId: updatedPayment.user.telegramId,
  }

  // Все активные офферы юзера помечаем как PAID
  await prisma.offerInstance.updateMany({
    where: {
      userId: user.id,
      status: OfferStatus.ACTIVE,
    },
    data: {
      status: OfferStatus.PAID,
      finishedAt: now,
    },
  })

  // Гасим напоминания
  await cancelRemindersForUser(user.id, now)

  const amountNumber = Number(updatedPayment.amount)
  const currency = updatedPayment.currency || 'RUB'

  // Сообщение пользователю + уведомление админам
  await sendAgreementAndNotifyAdmins(user, amountNumber, currency, '🦾 Купили гайд!')
}
