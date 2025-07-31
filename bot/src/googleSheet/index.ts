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

const FLUSH_BUFFER_KEY = 'sheets:buffer'
const PROCESSING_BUFFER_KEY = 'sheets:processing'

setInterval(async () => {
  const bufferExists = await redis.exists(FLUSH_BUFFER_KEY)
  if (!bufferExists) return

  const count = await redis.llen(FLUSH_BUFFER_KEY)
  if (count === 0) return

  const renamed = await redis.rename(FLUSH_BUFFER_KEY, PROCESSING_BUFFER_KEY).catch((err) => {
    if (err.message.includes('no such key')) {
      return false
    }
    throw err
  })

  if (renamed === false) return

  const items = await redis.lrange(PROCESSING_BUFFER_KEY, 0, -1)
  const parsed: SheetLog[] = items.map((item) => JSON.parse(item))

  try {
    await axios.post(SHEETS_ENDPOINT, parsed)
    await redis.del(PROCESSING_BUFFER_KEY)
    console.log('✅ Google Sheet: log sent.')
  } catch (err) {
    console.error('❌ Google Sheet: Failed to send data to Sheets:', err)

    if (parsed.length > 0) {
      const values = parsed.map((item) => JSON.stringify(item))
      await redis.lpush(FLUSH_BUFFER_KEY, ...values.reverse())
    }
    await redis.del(PROCESSING_BUFFER_KEY)
  }
}, FLUSH_INTERVAL_MS)
