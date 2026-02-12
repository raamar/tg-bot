import { env } from '$env/dynamic/private'
import { readFile } from 'node:fs/promises'

const getTelegramToken = () => {
	const token = env.TELEGRAM_TOKEN
	if (!token) {
		throw new Error('TELEGRAM_TOKEN is not set')
	}
	return token
}

const telegramRequest = async (method: string, body: URLSearchParams | FormData) => {
	const response = await fetch(`https://api.telegram.org/bot${getTelegramToken()}/${method}`, {
		method: 'POST',
		body,
	})
	const data = (await response.json()) as { ok: boolean; description?: string; result?: any }
	if (!response.ok || !data.ok) {
		throw new Error(data.description || `Telegram error: ${response.status}`)
	}
	return data.result
}

export const sendMessage = async (chatId: string, messageHtml: string) => {
	return telegramRequest(
		'sendMessage',
		new URLSearchParams({
			chat_id: chatId,
			text: messageHtml,
			parse_mode: 'HTML',
		}),
	)
}

export const sendMediaByFileId = async (
	chatId: string,
	media: { type: 'photo' | 'video'; fileId: string },
	caption?: string,
) => {
	if (media.type === 'photo') {
		return telegramRequest(
			'sendPhoto',
			new URLSearchParams({
				chat_id: chatId,
				photo: media.fileId,
				...(caption ? { caption, parse_mode: 'HTML' } : {}),
			}),
		)
	}

	return telegramRequest(
		'sendVideo',
		new URLSearchParams({
			chat_id: chatId,
			video: media.fileId,
			...(caption ? { caption, parse_mode: 'HTML' } : {}),
		}),
	)
}

export const sendMediaGroupByFileIds = async (
	chatId: string,
	media: { type: 'photo' | 'video'; fileId: string }[],
	caption?: string,
) => {
	const payload = media.map((item, index) => ({
		type: item.type,
		media: item.fileId,
		...(caption && index === 0 ? { caption, parse_mode: 'HTML' } : {}),
	}))

	return telegramRequest(
		'sendMediaGroup',
		new URLSearchParams({
			chat_id: chatId,
			media: JSON.stringify(payload),
		}),
	)
}

export const uploadMedia = async (
	chatId: string,
	item: { path: string; mime: string; name: string; type: 'photo' | 'video' },
	caption?: string,
) => {
	const buffer = await readFile(item.path)
	const file = new File([buffer], item.name, { type: item.mime })
	const form = new FormData()
	form.append('chat_id', chatId)
	form.append(item.type === 'photo' ? 'photo' : 'video', file)
	if (caption) {
		form.append('caption', caption)
		form.append('parse_mode', 'HTML')
	}

	const result = await telegramRequest(item.type === 'photo' ? 'sendPhoto' : 'sendVideo', form)
	if (item.type === 'photo') {
		const photos = result?.photo ?? []
		const last = photos[photos.length - 1]
		return last?.file_id as string
	}

	return result?.video?.file_id as string
}

export const uploadMediaGroup = async (
	chatId: string,
	items: { path: string; mime: string; name: string; type: 'photo' | 'video' }[],
	caption?: string,
) => {
	const form = new FormData()
	form.append('chat_id', chatId)

	const mediaPayload: any[] = []
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index]
		const buffer = await readFile(item.path)
		const file = new File([buffer], item.name, { type: item.mime })
		const attachName = `file_${index}`
		form.append(attachName, file)

		mediaPayload.push({
			type: item.type,
			media: `attach://${attachName}`,
			...(caption && index === 0 ? { caption, parse_mode: 'HTML' } : {}),
		})
	}

	form.append('media', JSON.stringify(mediaPayload))

	const result = await telegramRequest('sendMediaGroup', form)
	return (result as any[]).map((message, index) => {
		const item = items[index]
		if (item.type === 'photo') {
			const photos = message?.photo ?? []
			const last = photos[photos.length - 1]
			return last?.file_id as string
		}
		return message?.video?.file_id as string
	})
}
