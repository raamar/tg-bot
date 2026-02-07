import { randomUUID } from 'crypto'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { redis } from './redis'

const MEDIA_ROOT = '/tmp/broadcast-media'
const MEDIA_TTL = 60 * 60 * 6

export interface DraftMediaItem {
	key: string
	path: string
	mime: string
	name: string
	size: number
	type: 'photo' | 'video'
}

const draftKey = (draftId: string) => `broadcast:draft:${draftId}`

const ensureRoot = async () => {
	await mkdir(MEDIA_ROOT, { recursive: true })
}

const detectType = (mime: string): DraftMediaItem['type'] | null => {
	if (mime.startsWith('image/')) return 'photo'
	if (mime.startsWith('video/')) return 'video'
	return null
}

export const storeDraftMedia = async (files: File[], draftId?: string) => {
	if (!files.length) {
		throw new Error('NO_FILES')
	}

	const resolvedDraftId = draftId || randomUUID()
	await ensureRoot()

	const existingRaw = await redis.get(draftKey(resolvedDraftId))
	const existing: DraftMediaItem[] = existingRaw ? JSON.parse(existingRaw) : []

	const items: DraftMediaItem[] = []
	for (const file of files) {
		const type = detectType(file.type)
		if (!type) {
			throw new Error('UNSUPPORTED_MEDIA')
		}
		const key = randomUUID()
		const path = join(MEDIA_ROOT, `${resolvedDraftId}-${key}-${file.name}`)
		const buffer = Buffer.from(await file.arrayBuffer())
		await writeFile(path, buffer)
		items.push({
			key,
			path,
			mime: file.type,
			name: file.name,
			size: file.size,
			type,
		})
	}

	const merged = [...existing, ...items]
	await redis.set(draftKey(resolvedDraftId), JSON.stringify(merged), 'EX', MEDIA_TTL)

	return { draftId: resolvedDraftId, items: merged }
}

export const getDraftMedia = async (draftId: string) => {
	const raw = await redis.get(draftKey(draftId))
	return raw ? (JSON.parse(raw) as DraftMediaItem[]) : []
}

export const clearDraftMedia = async (draftId: string) => {
	const items = await getDraftMedia(draftId)
	await Promise.all(
		items.map(async (item) => {
			try {
				await unlink(item.path)
			} catch {
				// ignore
			}
		}),
	)
	await redis.del(draftKey(draftId))
}
