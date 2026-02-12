import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { clearDraftMedia, storeDraftMedia, getDraftMedia } from '$lib/server/mediaStore'

const MAX_FILES = 10

export const POST: RequestHandler = async ({ request }) => {
	const form = await request.formData()
	const draftId = String(form.get('draftId') ?? '').trim() || undefined
	const files = form.getAll('media')
		.filter((item): item is File => item instanceof File)

	if (!files.length) {
		return json({ error: 'NO_FILES' }, { status: 400 })
	}

	if (files.length > MAX_FILES) {
		return json({ error: 'TOO_MANY_FILES' }, { status: 400 })
	}

	try {
		if (draftId) {
			const existing = await getDraftMedia(draftId)
			if (existing.length + files.length > MAX_FILES) {
				return json({ error: 'TOO_MANY_FILES' }, { status: 400 })
			}
		}
		const { draftId: newDraftId, items } = await storeDraftMedia(files, draftId)
		return json({ draftId: newDraftId, items })
	} catch (error) {
		const message = error instanceof Error ? error.message : 'UPLOAD_FAILED'
		return json({ error: message }, { status: 400 })
	}
}

export const DELETE: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { draftId?: string }
	const draftId = body?.draftId
	if (!draftId) {
		return json({ error: 'DRAFT_REQUIRED' }, { status: 400 })
	}

	await clearDraftMedia(draftId)
	return json({ ok: true })
}
