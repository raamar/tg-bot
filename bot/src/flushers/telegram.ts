import { redis } from '../redis'

const FLUSH_INTERVAL_MS = 10000

export function startTelegramFlusher() {
  // setInterval(async () => {
  //   const count = await redis.llen('telegram:buffer')
  //   if (count === 0) {
  //     console.log('⏳ Telegram buffer is empty, skipping...')
  //     return
  //   }
  //   const items = await redis.lrange('telegram:buffer', 0, -1)
  //   const parsed = items.map((i) => JSON.parse(i))
  //   console.log(`🧾 Flushing ${count} items to Telegram`, parsed)
  //   // Обработка (например, отправка сообщений в Telegram)
  //   // await sendToTelegram(parsed)
  //   await redis.del('telegram:buffer')
  // }, FLUSH_INTERVAL_MS)
}
