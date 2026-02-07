import Redis from 'ioredis'
import { env } from '$env/dynamic/private'

const redisUrl = env.REDIS_URL

if (!redisUrl) {
	throw new Error('REDIS_URL is not set')
}

const globalForRedis = globalThis as typeof globalThis & {
	__distributionRedis?: Redis
	__distributionRedisPub?: Redis
}

export const redis =
	globalForRedis.__distributionRedis ?? new Redis(redisUrl, { maxRetriesPerRequest: null })
if (!globalForRedis.__distributionRedis) {
	globalForRedis.__distributionRedis = redis
}

export const redisPub =
	globalForRedis.__distributionRedisPub ?? redis.duplicate({ maxRetriesPerRequest: null })
if (!globalForRedis.__distributionRedisPub) {
	globalForRedis.__distributionRedisPub = redisPub
}

export const createRedisSub = () => redis.duplicate({ maxRetriesPerRequest: null })
