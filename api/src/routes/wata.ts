// src/routes/wataWebhook.ts
import { Router } from 'express'
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

// Подпись НЕ проверяем — используем готовый JSON (application/json)
router.post('/webhook', async (req, res) => {
  // уникальный id для увязки логов одного запроса
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`

  try {
    log(requestId, 'Incoming request meta', {
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      ips: req.ips,
      headers: req.headers,
      query: req.query,
      bodyType: typeof req.body,
    })

    if (!req.body) {
      log(requestId, 'Empty body')
      return res.status(400).send('Invalid body')
    }

    let data: WataWebhookPayload

    // На случай, если body всё ещё строка или Buffer по каким-то причинам
    if (typeof req.body === 'string') {
      try {
        data = JSON.parse(req.body)
      } catch (err) {
        log(requestId, 'Invalid JSON string in body', {
          error: err instanceof Error ? err.message : String(err),
          rawBody: req.body,
        })
        return res.status(400).send('Invalid JSON')
      }
    } else if (Buffer.isBuffer(req.body)) {
      const text = req.body.toString('utf8')
      try {
        data = JSON.parse(text)
      } catch (err) {
        log(requestId, 'Invalid JSON buffer in body', {
          error: err instanceof Error ? err.message : String(err),
          rawBody: text,
        })
        return res.status(400).send('Invalid JSON')
      }
    } else {
      // Обычный случай: express.json() уже распарсил body в объект
      data = req.body as WataWebhookPayload
    }

    log(requestId, 'Parsed JSON payload:', data)

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

    // ВАЖНО: предполагаем, что WATA order id = Payment.id
    const job = await cloudpaymentsQueue.add('process-payment', {
      status: 'Completed',
      invoiceId: data.id,
      amount: data.amount,
      raw: data as any,
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
    return res.status(500).send('Internal error')
  }
})

export default router
