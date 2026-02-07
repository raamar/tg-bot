import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { randomUUID } from 'crypto'
import { createRequire } from 'node:module'
import { env } from '$env/dynamic/private'
import {
	initBroadcastStatus,
	queueBroadcast,
	pushLog as _pushLog,
	pushError as _pushError,
} from '$lib/server/broadcast'
import { getDraftMedia, clearDraftMedia, type DraftMediaItem } from '$lib/server/mediaStore'
import { uploadMedia, uploadMediaGroup } from '$lib/server/telegram'

const require = createRequire(import.meta.url)
const { prisma } = require('@app/db') as typeof import('@app/db')

const MAX_CAPTION_LENGTH = 1024
const MIN_DELAY_MS = 50

const stripHtml = (value: string) =>
	value.replace(/<[^>]*>/g, '').replace(/\u00a0/g, ' ').trim()

const toTelegramHtml = (value: string) => {
	let html = value
		.replace(/<\/p>\s*<p>/g, '\n')
		.replace(/<\/p>/g, '')
		.replace(/<p>/g, '')
		.replace(/<br\s*\/?>/g, '\n')
		.replace(/&nbsp;/g, ' ')
		.replace(/<div>/g, '')
		.replace(/<\/div>/g, '\n')
	return html.trim()
}

const parseAdminIds = () => {
	const raw = env.ADMIN_IDS || ''
	return raw
		.split(',')
		.map((id) => id.trim())
		.filter((id) => id.length > 0)
}

const sanitizeIds = (values: string[]) => {
	const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0)
	return Array.from(new Set(normalized))
}

const parseTextContacts = async (file: File) => {
	const text = await file.text()
	const lines = text.split(/\r?\n/)
	return sanitizeIds(lines.map((line) => String(line ?? '')))
}

const parseManualContacts = (value: string) => {
	const lines = value.split(/\r?\n/)
	return sanitizeIds(lines)
}

const parseSingleContact = (value: string) => {
	return sanitizeIds([value])
}

const filterBlocked = async (contacts: string[]) => {
	if (contacts.length === 0) {
		return { allowed: [], blocked: [], notFound: [] }
	}

	const users = await prisma.user.findMany({
		where: {
			telegramId: { in: contacts },
		},
		select: { telegramId: true, blockedByUser: true },
	})

	const found = new Map(users.map((user) => [user.telegramId, user.blockedByUser]))
	const allowed: string[] = []
	const blocked: string[] = []
	const notFound: string[] = []

	for (const id of contacts) {
		if (!found.has(id)) {
			notFound.push(id)
			continue
		}
		if (found.get(id)) {
			blocked.push(id)
			continue
		}
		allowed.push(id)
	}

	return { allowed, blocked, notFound }
}

const prepareMediaForBroadcast = async (
	broadcastId: string,
	mediaItems: DraftMediaItem[],
	messageHtml: string,
	messageText: string,
	mediaChatId: string,
) => {
	if (mediaItems.length === 0) {
		return { media: [], captionMode: 'none' as const }
	}

	const captionAllowed = messageText.length > 0 && messageText.length <= MAX_CAPTION_LENGTH
	const captionMode = captionAllowed ? 'caption' : messageText.length ? 'separate' : 'none'

	if (mediaItems.length === 1) {
		const item = mediaItems[0]
		const fileId = await uploadMedia(mediaChatId, item, captionMode === 'caption' ? messageHtml : undefined)
		await _pushLog(broadcastId, 'info', `Медиа загружено в Telegram. Получен file_id.`)

		return {
			media: [{ type: item.type, fileId }],
			captionMode,
		}
	}

	const fileIds = await uploadMediaGroup(
		mediaChatId,
		mediaItems,
		captionMode === 'caption' ? messageHtml : undefined,
	)
	await _pushLog(broadcastId, 'info', `Медиа-группа загружена в Telegram. Получено файлов: ${fileIds.length}.`)

	const media = mediaItems.map((item, index) => ({ type: item.type, fileId: fileIds[index] }))

	return {
		media,
		captionMode,
	}
}

export const POST: RequestHandler = async ({ request }) => {
	const form = await request.formData()
	const mode = String(form.get('mode') ?? 'manual')
	const rawHtml = String(form.get('messageHtml') ?? '').trim()
	const messageHtml = toTelegramHtml(rawHtml)
	const messageText = stripHtml(messageHtml)
	const delayMsRaw = Number(form.get('delayMs') ?? '100')
	const delayMs = Number.isFinite(delayMsRaw) ? Math.max(delayMsRaw, MIN_DELAY_MS) : 500
	const draftId = String(form.get('draftId') ?? '').trim() || null
	const mediaKeysRaw = String(form.get('mediaKeys') ?? '')
	const mediaKeys = mediaKeysRaw ? mediaKeysRaw.split(',').map((item) => item.trim()).filter(Boolean) : []

	let contacts: string[] = []

	if (mode === 'all') {
		const users = await prisma.user.findMany({
			select: { telegramId: true },
		})
		contacts = users.map((user) => user.telegramId)
	} else if (mode === 'csv') {
		const file = form.get('contactsFile')
		if (!file || !(file instanceof File)) {
			return json({ error: 'CSV_REQUIRED' }, { status: 400 })
		}
		contacts = await parseTextContacts(file)
	} else if (mode === 'single') {
		contacts = parseSingleContact(String(form.get('singleId') ?? ''))
	} else {
		contacts = parseManualContacts(String(form.get('manualList') ?? ''))
	}

	if (contacts.length === 0) {
		return json({ error: 'NO_CONTACTS' }, { status: 400 })
	}

	const broadcastId = randomUUID()
	const createdAt = Date.now()
	await initBroadcastStatus({
		id: broadcastId,
		state: 'queued',
		total: contacts.length,
		success: 0,
		failed: 0,
		skipped: 0,
		createdAt,
		messagePreview: messageText.slice(0, 160),
	})

	const { allowed, blocked, notFound } = await filterBlocked(contacts)

	await _pushLog(broadcastId, 'info', `Контактов в списке: ${contacts.length}.`)
	if (blocked.length > 0) {
		await _pushLog(broadcastId, 'warn', `Заблокированы: ${blocked.length}.`)
		for (const id of blocked) {
			await _pushError(broadcastId, id, 'blocked_by_user')
		}
	}
	if (notFound.length > 0) {
		await _pushLog(broadcastId, 'warn', `Не найдены в базе: ${notFound.length}.`)
		for (const id of notFound) {
			await _pushError(broadcastId, id, 'not_found')
		}
	}

	if (allowed.length === 0) {
		await _pushLog(broadcastId, 'error', 'Нет доступных контактов после фильтрации.')
		return json({ error: 'NO_ALLOWED_CONTACTS', broadcastId }, { status: 400 })
	}

	let mediaItems: DraftMediaItem[] = []
	if (draftId) {
		const draft = await getDraftMedia(draftId)
		mediaItems = mediaKeys.length ? draft.filter((item) => mediaKeys.includes(item.key)) : draft
	}

	if (!messageText && mediaItems.length === 0) {
		return json({ error: 'EMPTY_MESSAGE' }, { status: 400 })
	}

	let preparedMedia: { type: 'photo' | 'video'; fileId: string }[] = []
	let captionMode: 'caption' | 'separate' | 'none' = 'none'
	const adminIds = parseAdminIds()
	const mediaChatId = adminIds[0]

	if (mediaItems.length > 0) {
		if (!mediaChatId) {
			return json({ error: 'NO_ADMIN_IDS', broadcastId }, { status: 400 })
		}
		const prepared = await prepareMediaForBroadcast(
			broadcastId,
			mediaItems,
			messageHtml,
			messageText,
			mediaChatId,
		)
		preparedMedia = prepared.media
		captionMode = prepared.captionMode
	}

	await initBroadcastStatus({
		id: broadcastId,
		state: 'queued',
		total: contacts.length,
		success: 0,
		failed: 0,
		skipped: blocked.length + notFound.length,
		createdAt,
		messagePreview: messageText.slice(0, 160),
		cursor: 0,
	})

	await _pushLog(
		broadcastId,
		'info',
		`К отправке: ${allowed.length}. Задержка: ${delayMs}мс.`,
	)

	await queueBroadcast({
		broadcastId,
		contacts: allowed,
		messageHtml,
		media: preparedMedia,
		captionMode,
		delayMs,
	})

	if (draftId) {
		await clearDraftMedia(draftId)
	}

	return json({
		broadcastId,
		total: contacts.length,
		blocked: blocked.length,
		notFound: notFound.length,
		queued: allowed.length,
	})
}
