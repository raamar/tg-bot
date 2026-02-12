import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import {
	clearActiveBroadcastId,
	clearLastBroadcastId,
	getActiveBroadcastId,
	getBroadcastErrors,
	getBroadcastLogs,
	getBroadcastStatus,
	getBroadcastUiState,
	getDraftUiState,
	getLastBroadcastId,
} from '$lib/server/broadcast'

export const GET: RequestHandler = async () => {
	const activeBroadcastId = await getActiveBroadcastId()
	if (activeBroadcastId) {
		const status = await getBroadcastStatus(activeBroadcastId)
		if (status) {
			return json({
				active: {
					broadcastId: activeBroadcastId,
					status,
					ui: await getBroadcastUiState(activeBroadcastId),
					logs: await getBroadcastLogs(activeBroadcastId, 200),
					errors: await getBroadcastErrors(activeBroadcastId),
				},
				last: null,
				draft: await getDraftUiState(),
			})
		}
		await clearActiveBroadcastId(activeBroadcastId)
	}

	const lastBroadcastId = await getLastBroadcastId()
	if (lastBroadcastId) {
		const lastStatus = await getBroadcastStatus(lastBroadcastId)
		if (lastStatus) {
			return json({
				active: null,
				last: {
					broadcastId: lastBroadcastId,
					status: lastStatus,
					ui: await getBroadcastUiState(lastBroadcastId),
					logs: await getBroadcastLogs(lastBroadcastId, 200),
					errors: await getBroadcastErrors(lastBroadcastId),
				},
				draft: await getDraftUiState(),
			})
		}
		await clearLastBroadcastId()
	}

	return json({ active: null, last: null, draft: await getDraftUiState() })
}
