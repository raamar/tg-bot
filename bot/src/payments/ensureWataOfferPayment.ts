// src/payments/ensureWataOfferPayment.ts

import { randomUUID } from 'node:crypto'
import { OfferInstance, PaymentStatus } from '@prisma/client'
import { prisma } from '../prisma'
import { CreatePaymentLinkRequest, WataClient, WataCurrency, WataMode } from './wata'

const wata = new WataClient({
  mode: 'prod',
})

/**
 * Гарантирует, что для конкретного OfferInstance есть WATA-платёж
 * и возвращает URL ссылки.
 *
 * Логика:
 *  - если уже есть Payment с offerInstanceId и валидным url
 *    (status != FAILED/CANCELED) — переиспользуем его;
 *  - иначе создаём новый Payment и новый WATA-линк.
 */
export async function ensureWataPaymentLinkForOffer(instance: OfferInstance): Promise<string> {
  // Ищем существующий платеж, привязанный к офферу
  const existing = await prisma.payment.findFirst({
    where: { offerInstanceId: instance.id },
    orderBy: { createdAt: 'desc' },
  })

  if (
    existing &&
    existing.url &&
    existing.status !== PaymentStatus.FAILED &&
    existing.status !== PaymentStatus.CANCELED
  ) {
    return existing.url
  }

  // Захардкоженное описание (можно при желании вынести в env)
  const description = 'Гайд: Миллион на ИИ аватаре'

  // initialPrice — Prisma Decimal, аккуратно приводим к number
  const amountNumber = Number(instance.initialPrice.toString())
  const currency = (instance.currency as WataCurrency) || 'RUB'

  // Генерируем id для Payment (чтобы Prisma не ругался и
  // было что передать в WATA orderId)
  const paymentId = randomUUID()

  const payment = await prisma.payment.create({
    data: {
      id: paymentId,
      userId: instance.userId,
      offerInstanceId: instance.id,
      amount: instance.initialPrice,
      currency: instance.currency,
      status: PaymentStatus.PENDING,
    },
  })

  const payload: CreatePaymentLinkRequest = {
    type: 'OneTime',
    amount: amountNumber,
    currency,
    description,
    orderId: payment.id,
    // successRedirectUrl и failRedirectUrl НЕ передаём —
    // можно настроить в личном кабинете WATA / использовать дефолты.
  }

  const link = await wata.createPaymentLink(payload)

  if (!link?.url) {
    throw new Error('WATA: не удалось получить URL платёжной ссылки')
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      url: link.url,
    },
  })

  return link.url
}
