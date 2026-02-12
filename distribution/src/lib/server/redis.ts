import Redis from 'ioredis'
import { env } from '$env/dynamic/private'

const globalForRedis = globalThis as typeof globalThis & {
	__distributionRedis?: Redis
	__distributionRedisPub?: Redis
}

const createClient = () => {
	const redisUrl = env.REDIS_URL
	if (!redisUrl) {
		throw new Error('REDIS_URL is not set')
	}
	return new Redis(redisUrl, { maxRetriesPerRequest: null })
}

export const getRedis = () => {
	if (!globalForRedis.__distributionRedis) {
		globalForRedis.__distributionRedis = createClient()
	}
	return globalForRedis.__distributionRedis
}

export const getRedisPub = () => {
	if (!globalForRedis.__distributionRedisPub) {
		globalForRedis.__distributionRedisPub = getRedis().duplicate({ maxRetriesPerRequest: null })
	}
	return globalForRedis.__distributionRedisPub
}

export const createRedisSub = () => getRedis().duplicate({ maxRetriesPerRequest: null })
