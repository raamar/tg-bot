import { Router } from 'express'
import { telegramQueue } from '../queues/telegram'

const router = Router()
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN

if (!process.env.TELEGRAM_TOKEN) {
  throw new Error('TELEGRAM_TOKEN is not defined')
}

router.get('/ping', (req, res) => {
  res.status(200).send('pong')
})

router.post('/telegram-webhook/:token', async (req, res) => {
  const tokenFromUrl = req.params.token

  if (tokenFromUrl !== TELEGRAM_TOKEN) {
    return res.status(403).send('Invalid token')
  }

  const update = req.body

  await telegramQueue.add('process-update', update)

  res.sendStatus(200)
})

export default router
