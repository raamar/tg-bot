import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { resumeBroadcast } from '$lib/server/broadcast'

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { id?: string }
	const broadcastId = body?.id

	if (!broadcastId) {
		return json({ error: 'ID_REQUIRED' }, { status: 400 })
	}

	try {
		await resumeBroadcast(broadcastId)
		return json({ ok: true })
	} catch (error) {
		const message = error instanceof Error ? error.message : 'RESUME_FAILED'
		return json({ error: message }, { status: 400 })
	}
}
