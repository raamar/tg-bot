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

// простой хелпер, можно потом заменить на свой logger
const log = (...args: any[]) => {
  // eslint-disable-next-line no-console
  console.log(new Date().toISOString(), '[WATA_WEBHOOK]', ...args)
}

// Подпись НЕ проверяем — просто читаем raw JSON и парсим
router.post('/webhook', raw({ type: '*/*' }), async (req, res) => {
  // уникальный id для увязки логов одного запроса
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`

  try {
    const rawBody = req.body as Buffer

    log(requestId, 'Incoming request meta', {
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      ips: req.ips,
      headers: req.headers,
      query: req.query,
    })

    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      log(requestId, 'Invalid body: not a Buffer', { bodyType: typeof rawBody })
      return res.status(400).send('Invalid body')
    }

    const text = rawBody.toString('utf8')
    log(requestId, 'Raw body text:', text)

    let data: WataWebhookPayload
    try {
      data = JSON.parse(text)
      log(requestId, 'Parsed JSON payload:', data)
    } catch (err) {
      log(requestId, 'Invalid JSON payload', {
        error: err instanceof Error ? err.message : String(err),
        rawBody: text,
      })
      return res.status(400).send('Invalid JSON')
    }

    if (!data.id || !data.transactionStatus) {
      log(requestId, 'Missing required fields', {
        hasId: Boolean(data.id),
        hasTransactionStatus: Boolean(data.transactionStatus),
      })
      return res.status(400).send('Missing fields')
    }

    // Логируем все входящие статусы, даже если игнорим
    if (data.transactionStatus !== 'Paid') {
      log(requestId, 'Non-paid transaction received, ignoring but returning 200', {
        id: data.id,
        transactionId: data.transactionId,
        transactionStatus: data.transactionStatus,
        errorCode: data.errorCode,
        errorDescription: data.errorDescription,
        amount: data.amount,
        currency: data.currency,
      })
      // В любом случае WATA ждёт 200 — иначе будет ретраить
      return res.json({ code: 0 })
    }

    log(requestId, 'Paid transaction received, enqueueing to cloudpaymentsQueue', {
      id: data.id,
      transactionId: data.transactionId,
      amount: data.amount,
      currency: data.currency,
      paymentTime: data.paymentTime,
      email: data.email,
      orderId: data.orderId,
      orderDescription: data.orderDescription,
    })

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
    const job = await cloudpaymentsQueue.add('process-payment', {
      status: 'Completed',
      invoiceId: data.id, // == Payment.id
      amount: data.amount,
      raw: data as any, // тип raw в воркере можно оставить как есть
    } as any)

    log(requestId, 'Job added to cloudpaymentsQueue', {
      jobId: job?.id,
      jobName: job?.name,
    })

    return res.json({ code: 0 })
  } catch (err) {
    log(requestId, 'Unhandled error in webhook handler', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
    // WATA всё равно будет ретраить, но лучше честно вернуть 500
    return res.status(500).send('Internal error')
  }
})

export default router
