// src/routes/wataWebhook.ts
import { Router, raw } from 'express'
import { cloudpaymentsQueue } from '../queues/cloudpayments'

const router = Router()

// Описание тела вебхука от WATA (минимально нужные поля)
type WataWebhookPayload = {
  transactionType: string
  id: string // order id в системе WATA
  transactionId: string
  terminalPublicId: string
  transactionStatus: 'Paid' | 'Declined' | string
  errorCode: string | null
  errorDescription: string | null
  terminalName: string
  amount: number
  currency: string
  orderId?: string | null
  orderDescription?: string | null
  commission?: number
  paymentTime: string
  email?: string | null
}

// Подпись НЕ проверяем — просто читаем raw JSON и парсим
router.post('/webhook', raw({ type: '*/*' }), async (req, res) => {
  const rawBody = req.body as Buffer

  if (!rawBody || !Buffer.isBuffer(rawBody)) {
    return res.status(400).send('Invalid body')
  }

  let data: WataWebhookPayload
  try {
    const text = rawBody.toString('utf8')
    data = JSON.parse(text)
  } catch {
    return res.status(400).send('Invalid JSON')
  }

  if (!data.id || !data.transactionStatus) {
    return res.status(400).send('Missing fields')
  }

  // Нас интересуют только успешные оплаты
  if (data.transactionStatus !== 'Paid') {
    // В любом случае WATA ждёт 200 — иначе будет ретраить
    return res.json({ code: 0 })
  }

  // 🔗 ВАЖНО:
  // здесь предполагается, что при создании ссылки на оплату
  // ты сохраняешь data.id (WATA order id) в Payment.id
  // (или наоборот — просто чтобы id из вебхука совпадал с Payment.id).
  //
  // Дальше шлём задачу в уже существующую очередь, которую обрабатывает бот.
  // CloudpaymentsQueuePayload:
  //   { status: 'Completed'; invoiceId: string; amount: number; raw: Record<string, string> }
  //
  // status жёстко ставим 'Completed', чтобы воркер воспринял это как успешную оплату.
  await cloudpaymentsQueue.add('process-payment', {
    status: 'Completed',
    invoiceId: data.id, // == Payment.id
    amount: data.amount,
    raw: data as any, // тип raw в воркере можно оставить как есть
  } as any)

  return res.json({ code: 0 })
})

export default router
