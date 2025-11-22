// src/routes/wataWebhook.ts
import { Router } from 'express'
import { cloudpaymentsQueue } from '../queues/cloudpayments'
import { prisma } from '../prisma'
import { PaymentStatus } from '@prisma/client'

const router = Router()

type WataWebhookPayload = {
  transactionType: string
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
  paymentLinkId?: string | null
}

const log = (...args: any[]) => {
  // eslint-disable-next-line no-console
  console.log(new Date().toISOString(), '[WATA_WEBHOOK]', ...args)
}

router.post('/webhook', async (req, res) => {
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

    if (typeof req.body === 'string') {
      data = JSON.parse(req.body)
    } else if (Buffer.isBuffer(req.body)) {
      data = JSON.parse(req.body.toString('utf8'))
    } else {
      data = req.body as WataWebhookPayload
    }

    log(requestId, 'Parsed JSON payload:', data)

    if (!data.transactionStatus) {
      log(requestId, 'Missing required fields', {
        hasTransactionStatus: Boolean(data.transactionStatus),
      })
      return res.status(400).send('Missing fields')
    }

    // наш внутренний идентификатор платежа (чем раньше в цепочке – тем приоритетнее)
    const invoiceId = data.orderId || data.paymentLinkId || data.transactionId

    if (!invoiceId) {
      log(requestId, 'No suitable invoiceId (orderId/paymentLinkId/transactionId) in payload')
      return res.status(400).send('Missing order identifier')
    }

    // Логируем все статусы
    if (data.transactionStatus !== 'Paid') {
      log(requestId, 'Non-paid transaction received, ignoring but returning 200', {
        invoiceId,
        transactionId: data.transactionId,
        transactionStatus: data.transactionStatus,
        errorCode: data.errorCode,
        errorDescription: data.errorDescription,
        amount: data.amount,
        currency: data.currency,
      })
      return res.json({ code: 0 })
    }

    // ---- ПРОВЕРКА НА ДУБЛИКАТ ----
    // Предполагаем, что invoiceId = Payment.id (или каким-то образом с ним связан)
    try {
      const existingPayment = await prisma.payment.findUnique({
        where: { id: invoiceId },
        select: {
          status: true,
          paidAt: true,
        },
      })

      if (existingPayment && existingPayment.status === PaymentStatus.PAID) {
        log(requestId, 'Duplicate paid webhook, payment already marked as PAID — skipping enqueue', {
          invoiceId,
          status: existingPayment.status,
          paidAt: existingPayment.paidAt,
        })
        return res.json({ code: 0 })
      }

      if (existingPayment) {
        log(requestId, 'Existing payment found, but not PAID (will enqueue)', {
          invoiceId,
          status: existingPayment.status,
          paidAt: existingPayment.paidAt,
        })
      } else {
        log(requestId, 'No payment record found for invoiceId (will enqueue anyway, worker should handle)', {
          invoiceId,
        })
      }
    } catch (e) {
      log(requestId, 'Error while checking duplicate payment in DB (continue anyway)', {
        invoiceId,
        error: e instanceof Error ? e.message : String(e),
      })
      // не валим запрос, просто логируем и продолжаем — хуже, если деньги не зачтём
    }
    // ---- КОНЕЦ ПРОВЕРКИ НА ДУБЛИКАТ ----

    log(requestId, 'Paid transaction received, enqueueing to cloudpaymentsQueue', {
      invoiceId,
      transactionId: data.transactionId,
      amount: data.amount,
      currency: data.currency,
      paymentTime: data.paymentTime,
      email: data.email,
      orderId: data.orderId,
      orderDescription: data.orderDescription,
      paymentLinkId: data.paymentLinkId,
    })

    const job = await cloudpaymentsQueue.add('process-payment', {
      status: 'Completed',
      invoiceId,
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
