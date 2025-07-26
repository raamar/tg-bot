import { Router } from 'express'
import { telegramQueue } from '../queues/telegram'

const router = Router()

router.get('/ping', (req, res) => {
  res.json({ status: 'ok' })
})

router.get('/telegram', async (req, res) => {
  await telegramQueue.add('telegram', {
    message: 'Hello from API Test',
  })
  res.status(200).json({ enqueued: true })
})

export default router
