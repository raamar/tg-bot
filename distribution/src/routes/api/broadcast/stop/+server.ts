import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requestStop, pushLog } from '$lib/server/broadcast'

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { id?: string }
	const broadcastId = body?.id

	if (!broadcastId) {
		return json({ error: 'ID_REQUIRED' }, { status: 400 })
	}

	await requestStop(broadcastId)
	await pushLog(broadcastId, 'warn', 'Остановка рассылки запрошена.')

	return json({ ok: true })
}
