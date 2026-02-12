import { Queue, Worker } from 'bullmq'
import { getRedis, getRedisPub } from './redis'
import { sendMediaByFileId, sendMediaGroupByFileIds, sendMessage } from './telegram'

const BROADCAST_QUEUE = 'distribution_broadcast'

const DEFAULT_CONCURRENCY = 1
const TTL_SECONDS = 60 * 60 * 10
const MIN_DELAY_MS = 50
const BATCH_SIZE = 500
const LOG_LIMIT = 2000
const ERROR_LIMIT = 5000
const ACTIVE_BROADCAST_KEY = 'broadcast:active'
const LAST_BROADCAST_KEY = 'broadcast:last'
const UI_DRAFT_KEY = 'broadcast:ui:draft'
const STATUS_PUBLISH_INTERVAL_MS = 1000
const RATE_WINDOW_SIZE = 120
const EMA_ALPHA = 0.2

let lastRequestAt = 0

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitForRateLimit = async (minInterval: number) => {
	const now = Date.now()
	const delta = now - lastRequestAt
	if (delta < minInterval) {
		await sleep(minInterval - delta)
	}
	lastRequestAt = Date.now()
}

export interface BroadcastJobData {
	broadcastId: string
	batchStart: number
	batchSize: number
	messageHtml: string
	media: { type: 'photo' | 'video'; fileId: string }[]
	captionMode: 'caption' | 'separate' | 'none'
	delayMs: number
}

const globalForQueues = globalThis as typeof globalThis & {
	__distributionBroadcastQueue?: Queue<BroadcastJobData>
	__distributionBroadcastWorker?: Worker<BroadcastJobData>
}

const getBroadcastQueue = () => {
	if (!globalForQueues.__distributionBroadcastQueue) {
		globalForQueues.__distributionBroadcastQueue = new Queue<BroadcastJobData>(
			BROADCAST_QUEUE,
			{ connection: getRedis() },
		)
	}
	return globalForQueues.__distributionBroadcastQueue
}

const keyStatus = (id: string) => `broadcast:status:${id}`
const keyStop = (id: string) => `broadcast:stop:${id}`
const keyLogs = (id: string) => `broadcast:logs:${id}`
const keyErrors = (id: string) => `broadcast:errors:${id}`
const keyContacts = (id: string) => `broadcast:contacts:${id}`
const keyMeta = (id: string) => `broadcast:meta:${id}`
const keyUi = (id: string) => `broadcast:ui:${id}`
const keyDurations = (id: string) => `broadcast:durations:${id}`
export const channelEvents = (id: string) => `broadcast:events:${id}`

export type BroadcastState = 'queued' | 'running' | 'stopping' | 'stopped' | 'completed'

export interface BroadcastStatus {
	id: string
	state: BroadcastState
	total: number
	success: number
	failed: number
	skipped: number
	createdAt: number
	startedAt?: number
	finishedAt?: number
	messagePreview?: string
	cursor?: number
	actualRate?: number
	etaSeconds?: number
}

export interface BroadcastUiState {
	step: number
	mode: 'all' | 'single' | 'csv' | 'manual'
	messageHtml: string
	delayMs: number
	singleId: string
	manualList: string
	fileStats: { total: number; nonEmpty: number; unique: number; duplicates: number } | null
	draftId: string | null
	mediaItems: { key: string; name: string; type: 'photo' | 'video'; size: number }[]
}

export const pushLog = async (
	broadcastId: string,
	level: 'info' | 'warn' | 'error',
	message: string,
) => {
	const payload = {
		ts: Date.now(),
		level,
		message,
	}
	const redis = getRedis()
	await redis.rpush(keyLogs(broadcastId), JSON.stringify(payload))
	await redis.ltrim(keyLogs(broadcastId), -LOG_LIMIT, -1)
	await redis.expire(keyLogs(broadcastId), TTL_SECONDS)
	await getRedisPub().publish(channelEvents(broadcastId), JSON.stringify({ type: 'log', payload }))
}

export const pushError = async (
	broadcastId: string,
	contactId: string,
	reason: string,
	error?: string,
) => {
	const payload = {
		ts: Date.now(),
		contactId,
		reason,
		error: error ?? null,
	}
	const redis = getRedis()
	await redis.rpush(keyErrors(broadcastId), JSON.stringify(payload))
	await redis.ltrim(keyErrors(broadcastId), -ERROR_LIMIT, -1)
	await redis.expire(keyErrors(broadcastId), TTL_SECONDS)
	await getRedisPub().publish(channelEvents(broadcastId), JSON.stringify({ type: 'issue', payload }))
}

const publishStatus = async (broadcastId: string) => {
	const redis = getRedis()
	const statusKey = keyStatus(broadcastId)
	const status = await redis.hgetall(statusKey)
	if (!status || Object.keys(status).length === 0) return

	const total = Number(status.total ?? 0)
	const success = Number(status.success ?? 0)
	const failed = Number(status.failed ?? 0)
	const skipped = Number(status.skipped ?? 0)
	const durationsRaw = await redis.lrange(keyDurations(broadcastId), -RATE_WINDOW_SIZE, -1)
	const durations = durationsRaw
		.map((value) => Number(value))
		.filter((value) => Number.isFinite(value) && value > 0)
		.sort((a, b) => a - b)

	const medianMs = durations.length > 0 ? durations[Math.floor(durations.length / 2)] : 0
	const p50Rate = medianMs > 0 ? 1000 / medianMs : 0
	const prevRate = Number(status.actualRate ?? 0)
	const nextRate = prevRate > 0 ? prevRate * (1 - EMA_ALPHA) + p50Rate * EMA_ALPHA : p50Rate
	const state = status.state
	const isActiveState = state === 'running' || state === 'queued' || state === 'stopping'
	const actualRate = isActiveState ? nextRate : 0

	const done = success + failed + skipped
	const remaining = Math.max(0, total - done)
	const etaSeconds =
		actualRate > 0 && isActiveState
			? Math.ceil(remaining / actualRate)
			: ''

	await redis.hset(statusKey, {
		actualRate: actualRate.toFixed(2),
		etaSeconds,
	})
	const freshStatus = await redis.hgetall(statusKey)
	await getRedisPub().publish(channelEvents(broadcastId), JSON.stringify({ type: 'status', payload: freshStatus }))
}

const updateState = async (broadcastId: string, state: BroadcastState) => {
	const redis = getRedis()
	await redis.hset(keyStatus(broadcastId), 'state', state)
	await publishStatus(broadcastId)
}

const checkDone = async (broadcastId: string) => {
	const redis = getRedis()
	const statusKey = keyStatus(broadcastId)
	const status = await redis.hgetall(statusKey)
	if (!status || !status.total) return

	const total = Number(status.total)
	const success = Number(status.success)
	const failed = Number(status.failed)
	const skipped = Number(status.skipped)

	if (success + failed + skipped >= total) {
		const stopFlag = await redis.get(keyStop(broadcastId))
		await redis.hset(statusKey, 'finishedAt', Date.now())
		await updateState(broadcastId, stopFlag ? 'stopped' : 'completed')
		if (!stopFlag) {
			const waitingJobs = await getBroadcastQueue().getJobs(['waiting', 'delayed'])
			const toRemove = waitingJobs.filter((job) => job.data.broadcastId === broadcastId)
			if (toRemove.length > 0) {
				await Promise.all(toRemove.map((job) => job.remove()))
			}
		}
		await setLastBroadcastId(broadcastId)
	}
}

const getContacts = async (broadcastId: string) => {
	const redis = getRedis()
	const raw = await redis.get(keyContacts(broadcastId))
	return raw ? (JSON.parse(raw) as string[]) : []
}

const setContacts = async (broadcastId: string, contacts: string[]) => {
	const redis = getRedis()
	await redis.set(keyContacts(broadcastId), JSON.stringify(contacts), 'EX', TTL_SECONDS)
}

const setMeta = async (broadcastId: string, meta: Omit<BroadcastJobData, 'batchStart' | 'batchSize'>) => {
	const redis = getRedis()
	await redis.set(keyMeta(broadcastId), JSON.stringify(meta), 'EX', TTL_SECONDS)
}

const getMeta = async (broadcastId: string) => {
	const redis = getRedis()
	const raw = await redis.get(keyMeta(broadcastId))
	return raw ? (JSON.parse(raw) as Omit<BroadcastJobData, 'batchStart' | 'batchSize'>) : null
}

const enqueueBatches = async (params: {
	broadcastId: string
	startIndex: number
	total: number
	messageHtml: string
	media: { type: 'photo' | 'video'; fileId: string }[]
	captionMode: 'caption' | 'separate' | 'none'
	delayMs: number
}) => {
	const { broadcastId, startIndex, total, messageHtml, media, captionMode, delayMs } = params
	let index = startIndex
	while (index < total) {
		const remainder = index % BATCH_SIZE
		const currentBatchSize = remainder === 0 ? BATCH_SIZE : BATCH_SIZE - remainder
		await getBroadcastQueue().add(
			'batch',
			{
				broadcastId,
				batchStart: index,
				batchSize: Math.min(currentBatchSize, total - index),
				messageHtml,
				media,
				captionMode,
				delayMs,
			},
			{
				jobId: `${broadcastId}:${index}`,
				removeOnComplete: true,
				removeOnFail: false,
			},
		)
		index += currentBatchSize
	}
}

const ensureWorker = () => {
	if (globalForQueues.__distributionBroadcastWorker) return
	globalForQueues.__distributionBroadcastWorker = new Worker<BroadcastJobData>(
		BROADCAST_QUEUE,
		async (job) => {
			const { broadcastId, batchStart, batchSize, messageHtml, media, captionMode, delayMs } = job.data
			const redis = getRedis()
			const statusBefore = await redis.hget(keyStatus(broadcastId), 'state')
			if (statusBefore === 'completed') {
				return
			}

			await updateState(broadcastId, 'running')
			const startedAt = await redis.hget(keyStatus(broadcastId), 'startedAt')
			if (!startedAt) {
				await redis.hset(keyStatus(broadcastId), 'startedAt', Date.now())
				await pushLog(broadcastId, 'info', 'Рассылка запущена.')
			}

			const contacts = await getContacts(broadcastId)
			const batch = contacts.slice(batchStart, batchStart + batchSize)
			if (batch.length === 0) return
			let lastStatusPublishAt = Date.now()

			for (let index = 0; index < batch.length; index += 1) {
				const currentState = await redis.hget(keyStatus(broadcastId), 'state')
				if (currentState === 'completed') {
					return
				}
				const stopFlag = await redis.get(keyStop(broadcastId))
				if (stopFlag) {
					await pushLog(broadcastId, 'warn', 'Рассылка приостановлена.')
					return
				}

				const contactId = batch[index]
				const attemptStartedAt = Date.now()
				try {
					const interval = Math.max(delayMs, MIN_DELAY_MS)
					if (media.length === 0) {
						if (messageHtml) {
							await waitForRateLimit(interval)
							await sendMessage(contactId, messageHtml)
						}
					} else if (media.length === 1) {
						const caption = captionMode === 'caption' ? messageHtml : undefined
						await waitForRateLimit(interval)
						await sendMediaByFileId(contactId, media[0], caption)
						if (captionMode === 'separate' && messageHtml) {
							await waitForRateLimit(interval)
							await sendMessage(contactId, messageHtml)
						}
					} else {
						const caption = captionMode === 'caption' ? messageHtml : undefined
						await waitForRateLimit(interval)
						await sendMediaGroupByFileIds(contactId, media, caption)
						if (captionMode === 'separate' && messageHtml) {
							await waitForRateLimit(interval)
							await sendMessage(contactId, messageHtml)
						}
					}

					await redis.hincrby(keyStatus(broadcastId), 'success', 1)
					await pushLog(broadcastId, 'info', `Отправлено ${contactId}.`)
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					await redis.hincrby(keyStatus(broadcastId), 'failed', 1)
					await pushError(broadcastId, contactId, 'send_failed', message)
					await pushLog(broadcastId, 'error', `Ошибка ${contactId}: ${message}`)
				}

				await redis.hincrby(keyStatus(broadcastId), 'cursor', 1)
				await redis.rpush(keyDurations(broadcastId), String(Date.now() - attemptStartedAt))
				await redis.ltrim(keyDurations(broadcastId), -RATE_WINDOW_SIZE, -1)
				await redis.expire(keyDurations(broadcastId), TTL_SECONDS)

				const isLastInBatch = index === batch.length - 1
				const now = Date.now()
				if (isLastInBatch || now - lastStatusPublishAt >= STATUS_PUBLISH_INTERVAL_MS) {
					await publishStatus(broadcastId)
					lastStatusPublishAt = now
				}
			}

			await checkDone(broadcastId)
		},
		{ connection: getRedis(), concurrency: DEFAULT_CONCURRENCY },
	)
}

export const initBroadcastStatus = async (status: BroadcastStatus) => {
	const redis = getRedis()
	await redis.hset(keyStatus(status.id), {
		state: status.state,
		total: status.total,
		success: status.success,
		failed: status.failed,
		skipped: status.skipped,
		createdAt: status.createdAt,
		startedAt: status.startedAt ?? '',
		finishedAt: status.finishedAt ?? '',
		messagePreview: status.messagePreview ?? '',
		cursor: status.cursor ?? 0,
		actualRate: status.actualRate ?? 0,
		etaSeconds: status.etaSeconds ?? '',
	})
	await redis.expire(keyStatus(status.id), TTL_SECONDS)
	await redis.expire(keyLogs(status.id), TTL_SECONDS)
	await redis.expire(keyErrors(status.id), TTL_SECONDS)
	await redis.expire(keyStop(status.id), TTL_SECONDS)
	await redis.del(keyDurations(status.id))
	await publishStatus(status.id)
}

export const getBroadcastStatus = async (broadcastId: string) => {
	const redis = getRedis()
	const status = await redis.hgetall(keyStatus(broadcastId))
	if (!status || Object.keys(status).length === 0) {
		return null
	}

	return status
}

export const getBroadcastErrors = async (broadcastId: string) => {
	const redis = getRedis()
	const errors = await redis.lrange(keyErrors(broadcastId), 0, -1)
	return errors.map((item) => {
		try {
			return JSON.parse(item)
		} catch {
			return { raw: item }
		}
	})
}

export const getBroadcastLogs = async (broadcastId: string, limit = 200) => {
	const redis = getRedis()
	const logs = await redis.lrange(keyLogs(broadcastId), -limit, -1)
	return logs.map((item) => {
		try {
			return JSON.parse(item)
		} catch {
			return { raw: item }
		}
	})
}

export const getActiveBroadcastId = async () => {
	const redis = getRedis()
	return redis.get(ACTIVE_BROADCAST_KEY)
}

export const getLastBroadcastId = async () => {
	const redis = getRedis()
	return redis.get(LAST_BROADCAST_KEY)
}

export const setActiveBroadcastId = async (broadcastId: string) => {
	const redis = getRedis()
	await redis.set(ACTIVE_BROADCAST_KEY, broadcastId, 'EX', TTL_SECONDS)
}

export const setLastBroadcastId = async (broadcastId: string) => {
	const redis = getRedis()
	await redis.set(LAST_BROADCAST_KEY, broadcastId, 'EX', TTL_SECONDS)
}

export const clearActiveBroadcastId = async (broadcastId?: string) => {
	const redis = getRedis()
	if (!broadcastId) {
		await redis.del(ACTIVE_BROADCAST_KEY)
		return
	}
	const current = await redis.get(ACTIVE_BROADCAST_KEY)
	if (current === broadcastId) {
		await redis.del(ACTIVE_BROADCAST_KEY)
	}
}

export const clearLastBroadcastId = async () => {
	const redis = getRedis()
	await redis.del(LAST_BROADCAST_KEY)
}

export const refreshActiveTtl = async () => {
	const redis = getRedis()
	await redis.expire(ACTIVE_BROADCAST_KEY, TTL_SECONDS)
}

export const saveDraftUiState = async (state: BroadcastUiState) => {
	const redis = getRedis()
	await redis.set(UI_DRAFT_KEY, JSON.stringify(state), 'EX', TTL_SECONDS)
}

export const getDraftUiState = async () => {
	const redis = getRedis()
	const raw = await redis.get(UI_DRAFT_KEY)
	return raw ? (JSON.parse(raw) as BroadcastUiState) : null
}

export const clearDraftUiState = async () => {
	const redis = getRedis()
	await redis.del(UI_DRAFT_KEY)
}

export const saveBroadcastUiState = async (broadcastId: string, state: BroadcastUiState) => {
	const redis = getRedis()
	await redis.set(keyUi(broadcastId), JSON.stringify(state), 'EX', TTL_SECONDS)
}

export const getBroadcastUiState = async (broadcastId: string) => {
	const redis = getRedis()
	const raw = await redis.get(keyUi(broadcastId))
	return raw ? (JSON.parse(raw) as BroadcastUiState) : null
}

export const moveDraftUiStateToBroadcast = async (broadcastId: string) => {
	const redis = getRedis()
	const draftRaw = await redis.get(UI_DRAFT_KEY)
	if (!draftRaw) return
	await redis.set(keyUi(broadcastId), draftRaw, 'EX', TTL_SECONDS)
	await redis.del(UI_DRAFT_KEY)
}

export const clearBroadcastUiState = async (broadcastId: string) => {
	const redis = getRedis()
	await redis.del(keyUi(broadcastId))
}

export const finishBroadcastSession = async (broadcastId: string) => {
	const status = await getBroadcastStatus(broadcastId)
	if (status && status.state !== 'completed' && status.state !== 'stopped') {
		await requestStop(broadcastId)
	}

	await clearActiveBroadcastId(broadcastId)
	await clearLastBroadcastId()
	await clearBroadcastUiState(broadcastId)
	await clearDraftUiState()
}

export const requestStop = async (broadcastId: string) => {
	const redis = getRedis()
	await redis.set(keyStop(broadcastId), '1')
	await updateState(broadcastId, 'stopping')

	const waitingJobs = await getBroadcastQueue().getJobs(['waiting', 'delayed'])
	const toRemove = waitingJobs.filter((job) => job.data.broadcastId === broadcastId)
	if (toRemove.length > 0) {
		await Promise.all(toRemove.map((job) => job.remove()))
		await pushLog(broadcastId, 'warn', `Удалено задач: ${toRemove.length}.`)
		await publishStatus(broadcastId)
	}
	await updateState(broadcastId, 'stopped')
	await setLastBroadcastId(broadcastId)
}

export const queueBroadcast = async (data: {
	broadcastId: string
	contacts: string[]
	messageHtml: string
	media: { type: 'photo' | 'video'; fileId: string }[]
	captionMode: 'caption' | 'separate' | 'none'
	delayMs: number
}) => {
	await setContacts(data.broadcastId, data.contacts)
	await setMeta(data.broadcastId, {
		broadcastId: data.broadcastId,
		messageHtml: data.messageHtml,
		media: data.media,
		captionMode: data.captionMode,
		delayMs: data.delayMs,
	})
	await setActiveBroadcastId(data.broadcastId)
	await setLastBroadcastId(data.broadcastId)
	ensureWorker()
	await enqueueBatches({
		broadcastId: data.broadcastId,
		startIndex: 0,
		total: data.contacts.length,
		messageHtml: data.messageHtml,
		media: data.media,
		captionMode: data.captionMode,
		delayMs: data.delayMs,
	})
}

export const resumeBroadcast = async (broadcastId: string) => {
	const status = await getBroadcastStatus(broadcastId)
	if (!status) {
		throw new Error('NOT_FOUND')
	}
	const meta = await getMeta(broadcastId)
	if (!meta) {
		throw new Error('NO_META')
	}
	const cursor = Number(status.cursor ?? 0)
	const total = Number(status.total ?? 0)
	const redis = getRedis()
	await redis.del(keyStop(broadcastId))
	await updateState(broadcastId, 'queued')
	await setActiveBroadcastId(broadcastId)
	ensureWorker()
	await enqueueBatches({
		broadcastId,
		startIndex: cursor,
		total,
		messageHtml: meta.messageHtml,
		media: meta.media,
		captionMode: meta.captionMode,
		delayMs: meta.delayMs,
	})
	await pushLog(broadcastId, 'info', 'Рассылка продолжена.')
}
