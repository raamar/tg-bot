import { Router } from 'express'
import telegram from './telegram'
import wata from './wata'
const router = Router()

router.get('/ping', (req, res) => {
  res.status(200).send('pong')
})

router.use('/telegram', telegram)
router.use('/wata', wata)

router.use((req, res) => {
  res.status(404).json({ error: 'Not Found' })
})

export default router
