import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { finishBroadcastSession, getActiveBroadcastId } from '$lib/server/broadcast'

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { id?: string | null }
	const requestedId = body?.id?.trim() || null
	const activeId = await getActiveBroadcastId()

	const broadcastId = requestedId ?? activeId
	if (!broadcastId) {
		return json({ error: 'ID_REQUIRED' }, { status: 400 })
	}

	await finishBroadcastSession(broadcastId)
	return json({ ok: true })
}
