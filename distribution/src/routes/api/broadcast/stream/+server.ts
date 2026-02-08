import type { RequestHandler } from './$types'
import { createRedisSub } from '$lib/server/redis'
import { channelEvents, getBroadcastLogs, getBroadcastStatus, refreshActiveTtl } from '$lib/server/broadcast'

export const GET: RequestHandler = async ({ url }) => {
	const broadcastId = url.searchParams.get('id')
	if (!broadcastId) {
		return new Response('ID_REQUIRED', { status: 400 })
	}

	const status = await getBroadcastStatus(broadcastId)
	if (!status) {
		return new Response('NOT_FOUND', { status: 404 })
	}

	const encoder = new TextEncoder()
	const sub = createRedisSub()
	await sub.subscribe(channelEvents(broadcastId))

	const stream = new ReadableStream({
		start(controller) {
			let closed = false
			const send = (event: string, payload: unknown) => {
				if (closed) return
				try {
					controller.enqueue(
						encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
					)
				} catch {
					closed = true
				}
			}

			const heartbeat = setInterval(() => {
				send('ping', {})
			}, 15000)

			sub.on('message', (_channel, message) => {
				try {
					const parsed = JSON.parse(message)
					send(parsed.type || 'log', parsed.payload ?? parsed)
				} catch {
					send('log', { ts: Date.now(), level: 'info', message })
				}
			})

			const bootstrap = async () => {
				const latestStatus = await getBroadcastStatus(broadcastId)
				if (latestStatus) {
					send('status', latestStatus)
				}
				const logs = await getBroadcastLogs(broadcastId, 200)
				for (const log of logs) {
					send('log', log)
				}
				await refreshActiveTtl()
			}
			void bootstrap()

			return () => {
				closed = true
				clearInterval(heartbeat)
				sub.disconnect()
			}
		},
		cancel() {
			sub.disconnect()
		},
	})

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	})
}
