import { Worker } from 'bullmq'
import { redis } from '../redis'
import { prisma } from '../prisma'

new Worker(
  'telegram',
  async (job) => {
    console.log(`Added massage `)
    // const payload = job.data

    // await redis.rpush('telegram:buffer', JSON.stringify(payload))

    // const count = await redis.llen('telegram:buffer')
  },
  {
    connection: redis,
  }
)
