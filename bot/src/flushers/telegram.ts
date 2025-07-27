import { Worker } from 'bullmq'
import { redis } from '../redis'

const FLUSH_INTERVAL_MS = 10000

export function startTelegramFlusher() {
  return

  /**
   * Flusher example for Telegram updates.
   */
  setInterval(async () => {
    const count = await redis.llen('telegram:buffer')
    if (count === 0) {
      console.log('⏳ Telegram buffer is empty, skipping...')
      return
    }
    const items = await redis.lrange('telegram:buffer', 0, -1)
    const parsed = items.map((i) => JSON.parse(i))
    console.log(`🧾 Flushing ${count} items to Telegram`, parsed)
    await redis.del('telegram:buffer')
  }, FLUSH_INTERVAL_MS)

  new Worker(
    'telegram',
    async (job) => {
      const payload = job.data

      await redis.rpush('telegram:buffer', JSON.stringify(payload))

      const count = await redis.llen('telegram:buffer')
    },
    {
      connection: redis,
    }
  )
}
