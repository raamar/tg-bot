import { Router } from 'express'
import { telegramQueue1, telegramQueue2 } from '../queues/telegram'

const router = Router()

const TOKEN_1 = process.env.TELEGRAM_TOKEN
const TOKEN_2 = process.env.TELEGRAM_TOKEN_2

if (!TOKEN_1) throw new Error('TELEGRAM_TOKEN is not defined')
if (!TOKEN_2) throw new Error('TELEGRAM_TOKEN_2 is not defined')

router.post('/webhook/:token', async (req, res) => {
  const token = req.params.token
  const update = req.body

  if (token === TOKEN_1) {
    await telegramQueue1.add('process-update', update)
    return res.sendStatus(200)
  }

  if (token === TOKEN_2) {
    await telegramQueue2.add('process-update', update)
    return res.sendStatus(200)
  }

  return res.status(403).send('Invalid token')
})

export default router
