import axios from 'axios'
import { Worker, Queue } from 'bullmq'
import { redis } from '../redis'
import { SheetLog } from '../types/funnel'

if (!process.env.GOOGLE_SHEET_INTERVAL) {
  throw new Error('GOOGLE_SHEET_INTERVAL is not defined')
}

if (!process.env.GOOGLE_SHEET_ENDPOINT) {
  throw new Error('GOOGLE_SHEET_ENDPOINT is not defined')
}

const FLUSH_INTERVAL_MS = parseInt(process.env.GOOGLE_SHEET_INTERVAL, 10)
const REDIS_KEY = 'sheets:buffer'
const SHEETS_ENDPOINT = process.env.GOOGLE_SHEET_ENDPOINT

export const googleSheetQueue = new Queue<SheetLog>('googleSheet', {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 3,
    backoff: { type: 'fixed', delay: 3000 },
  },
})

const startSheetsManager = () => {
  setInterval(async () => {
    const count = await redis.llen(REDIS_KEY)
    if (count === 0) {
      // console.log('⏳  Google Sheet: buffer is empty, skipping...')
      return
    }

    const items = await redis.lrange(REDIS_KEY, 0, -1)
    const parsed: SheetLog[] = items.map((item) => JSON.parse(item))

    try {
      await axios.post(SHEETS_ENDPOINT, parsed)
      await redis.del(REDIS_KEY)
      console.log('✅ Google Sheet: log sended.')
    } catch (err) {
      console.error('❌ Google Sheet: Failed to send data to Sheets:', err)
    }
  }, FLUSH_INTERVAL_MS)

  new Worker<SheetLog>(
    'googleSheet',
    async (job) => {
      const payload = job.data

      if (!payload.user_id) {
        console.warn('⚠️ Google Sheet: Invalid log entry: missing user_id')
        return
      }

      const sortedPayload: Record<string, unknown> = Object.keys(payload)
        .sort()
        .reduce((acc, key) => {
          acc[key] = payload[key as keyof SheetLog]
          return acc
        }, {} as Record<string, unknown>)

      await redis.rpush(REDIS_KEY, JSON.stringify(sortedPayload))
      // const count = await redis.llen(REDIS_KEY)
      // console.log(`🗂️  Google Sheet: Sheets log added. Current buffer size: ${count}`)
    },
    {
      connection: redis,
    }
  )
}

/**
 * FIRST INIT FOR SHEETS
 */
googleSheetQueue
  .add('update', {
    user_telegram_id: 'SYSTEM',
    user_id: 'RESTART',
    username: '',
    first_name: '',
    last_name: '',
    joined_at: '',
    ref_code: '',
    stage: '',
    amount: '',
    order_url: '',
    paid_at: '',
    payment_status: '',
  })
  .then(() => {})

startSheetsManager()
