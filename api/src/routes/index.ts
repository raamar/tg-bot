import { Router } from 'express'
import telegram from './telegram'
import cloudpayments from './cloudpayments'
const router = Router()

router.get('/ping', (req, res) => {
  res.status(200).send('pong')
})

router.use('/telegram', telegram)
router.use('/cloudpayments', cloudpayments)

export default router
