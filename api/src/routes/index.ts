import { Router } from 'express'
import { telegramQueue } from '../queues/telegram'

const router = Router()

router.get('/ping', (req, res) => {
  res.status(200).send('pong')
})

router.post('/telegram-webhook', async (req, res) => {
  const update = req.body

  await telegramQueue.add('process-update', update)

  res.sendStatus(200)
})

export default router
