import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { getBroadcastErrors, getBroadcastLogs, getBroadcastStatus } from '$lib/server/broadcast'

export const GET: RequestHandler = async ({ url }) => {
	const broadcastId = url.searchParams.get('id')
	const includeErrors = url.searchParams.get('includeErrors') === '1'
	const includeLogs = url.searchParams.get('includeLogs') === '1'

	if (!broadcastId) {
		return json({ error: 'ID_REQUIRED' }, { status: 400 })
	}

	const status = await getBroadcastStatus(broadcastId)
	if (!status) {
		return json({ error: 'NOT_FOUND' }, { status: 404 })
	}

	const response: Record<string, unknown> = { status }

	if (includeErrors) {
		response.errors = await getBroadcastErrors(broadcastId)
	}
	if (includeLogs) {
		response.logs = await getBroadcastLogs(broadcastId)
	}

	return json(response)
}
