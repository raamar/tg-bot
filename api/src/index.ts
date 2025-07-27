import express from 'express'
import routes from './routes'
import { redis } from './redis'
import cors from 'cors'
import morgan from 'morgan'

const app = express()

if (process.env.NODE_ENV === 'development') {
  app.use(cors())
}

app.use(morgan(':method :url :status :remote-addr :response-time ms :date[iso]'))
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
