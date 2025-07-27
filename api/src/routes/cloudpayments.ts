import crypto from 'crypto'
import { Router } from 'express'
import { cloudpaymentsQueue } from '../queues/cloudpayments'
import { raw } from 'express'

const router = Router()

const CLOUDPAYMENTS_SECRET = process.env.CLOUDPAYMENTS_API_SECRET

if (!CLOUDPAYMENTS_SECRET) {
  throw new Error('CLOUDPAYMENTS_API_SECRET is not defined')
}

// const payload = 'Status=Completed&InvoiceId=2ef2478a-4ecc-4c1b-88a7-dcd64592138d&Amount=1490.00'
// const hmac = crypto.createHmac('sha256', CLOUDPAYMENTS_SECRET!).update(payload).digest('base64')
// console.log('Content-HMAC:', hmac)

function verifyCloudPaymentsSignature(body: Buffer, signature: string | undefined): boolean {
  if (!signature) return false

  const expected = crypto.createHmac('sha256', CLOUDPAYMENTS_SECRET!).update(body).digest('base64')

  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'))
  } catch {
    return false
  }
}

router.post('/webhook', raw({ type: '*/*' }), async (req, res) => {
  const rawBody = req.body
  const signature = req.headers['content-hmac'] as string

  if (!signature || !verifyCloudPaymentsSignature(rawBody, signature)) {
    return res.status(400).send('Invalid HMAC signature')
  }

  const bodyString = rawBody.toString()
  const params = new URLSearchParams(bodyString)
  const status = params.get('Status')
  const invoiceId = params.get('InvoiceId')
  const amount = params.get('Amount')

  if (!status || !invoiceId) {
    return res.status(400).send('Missing fields')
  }

  await cloudpaymentsQueue.add('process-payment', {
    status,
    invoiceId,
    amount,
    raw: Object.fromEntries(params),
  })

  return res.json({ code: 0 })
})

export default router
