// src/routes/wataWebhook.ts
import { Router } from 'express'
import { cloudpaymentsQueue } from '../queues/cloudpayments'

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

    // вычисляем наш "invoiceId"
    const invoiceId = data.orderId || data.paymentLinkId || data.transactionId

    if (!invoiceId) {
      log(requestId, 'No suitable invoiceId (orderId/paymentLinkId/transactionId) in payload')
      return res.status(400).send('Missing order identifier')
    }

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
      invoiceId, // <-- тут теперь orderId / paymentLinkId / transactionId
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
