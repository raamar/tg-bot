import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import {
	getActiveBroadcastId,
	refreshActiveTtl,
	saveBroadcastUiState,
	saveDraftUiState,
	type BroadcastUiState,
} from '$lib/server/broadcast'

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as {
		broadcastId?: string | null
		state?: BroadcastUiState | null
	}

	if (!body?.state) {
		return json({ error: 'STATE_REQUIRED' }, { status: 400 })
	}

	const activeBroadcastId = await getActiveBroadcastId()
	const targetBroadcastId = body.broadcastId?.trim() || null

	if (targetBroadcastId) {
		if (activeBroadcastId && activeBroadcastId !== targetBroadcastId) {
			return json({ error: 'ACTIVE_BROADCAST_MISMATCH', broadcastId: activeBroadcastId }, { status: 409 })
		}
		await saveBroadcastUiState(targetBroadcastId, body.state)
		await refreshActiveTtl()
		return json({ ok: true })
	}

	if (activeBroadcastId) {
		await saveBroadcastUiState(activeBroadcastId, { ...body.state, step: 3 })
		await refreshActiveTtl()
		return json({ ok: true, lockedBy: activeBroadcastId })
	}

	await saveDraftUiState(body.state)
	return json({ ok: true })
}
