import express from 'express'
import routes from './routes'
import { redis } from './redis'

const app = express()
app.use(express.json())
app.use(routes)

const PORT = process.env.PORT || 3000

redis
  .ping()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ API server running on port ${PORT}`)
    })
  })
  .catch((err) => {
    console.error('❌ Redis not available:', err)
  })
