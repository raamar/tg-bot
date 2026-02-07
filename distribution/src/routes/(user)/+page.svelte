<script lang="ts">
	import { Editor, Mark, mergeAttributes } from '@tiptap/core'
	import StarterKit from '@tiptap/starter-kit'
	import Underline from '@tiptap/extension-underline'
	import Link from '@tiptap/extension-link'
	import type { Action } from 'svelte/action'

	const Spoiler = Mark.create({
		name: 'spoiler',
		addAttributes: () => ({
			class: {
				default: 'tg-spoiler',
			},
		}),
		parseHTML: () => [{ tag: 'span.tg-spoiler' }],
		renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes(HTMLAttributes), 0],
		addCommands: () => ({
			toggleSpoiler:
				() =>
				({ commands }) =>
					commands.toggleMark('spoiler'),
		}),
	})

	type Mode = 'all' | 'single' | 'csv' | 'manual'
	type LogEntry = { ts: number; level: 'info' | 'warn' | 'error'; message: string }
	type ErrorEntry = { ts: number; contactId: string; reason: string; error?: string | null }
	type StatusPayload = Record<string, string>
	type MediaItem = {
		key: string
		name: string
		type: 'photo' | 'video'
		previewUrl: string
		size: number
	}

	type BroadcastState = {
		step: number
		mode: Mode
		messageHtml: string
		delayMs: number
		singleId: string
		manualList: string
		contactsFile: File | null
		fileStats: { total: number; nonEmpty: number; unique: number; duplicates: number } | null
		editor: Editor | null
		isSubmitting: boolean
		errorMessage: string
		broadcastId: string | null
		status: StatusPayload | null
		logs: LogEntry[]
		errors: ErrorEntry[]
		eventSource: EventSource | null
		draftId: string | null
		mediaItems: MediaItem[]
		isUploadingMedia: boolean
	}

	let state = $state<BroadcastState>({
		step: 1,
		mode: 'manual',
		messageHtml: '',
		delayMs: 100,
		singleId: '',
		manualList: '',
		contactsFile: null,
		fileStats: null,
		editor: null,
		isSubmitting: false,
		errorMessage: '',
		broadcastId: null,
		status: null,
		logs: [],
		errors: [],
		eventSource: null,
		draftId: null,
		mediaItems: [],
		isUploadingMedia: false,
	})

	const MIN_DELAY = 50
	const isBrowser = typeof window !== 'undefined'

	const formatDate = (value?: string | number | null) => {
		if (!value) return '—'
		const num = typeof value === 'string' ? Number(value) : value
		if (!num || Number.isNaN(num)) return '—'
		return new Date(num).toLocaleString('ru-RU')
	}

	const progressValue = $derived.by(() => {
		const total = Number(state.status?.total ?? 0)
		const success = Number(state.status?.success ?? 0)
		const failed = Number(state.status?.failed ?? 0)
		const skipped = Number(state.status?.skipped ?? 0)
		const done = success + failed + skipped
		return total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100))
	})

	const speedLabel = $derived.by(() => {
		const ms = Math.max(state.delayMs, MIN_DELAY)
		const perSecond = Math.round((1000 / ms) * 10) / 10
		return `${perSecond} сообщений/сек`
	})

	const attachSse = (id: string) => {
		state.eventSource?.close()
		state.eventSource = new EventSource(`/api/broadcast/stream?id=${id}`)

		state.eventSource.addEventListener('status', (event) => {
			state.status = JSON.parse((event as MessageEvent).data)
			if (state.status?.state === 'completed' || state.status?.state === 'stopped') {
				void loadErrors(id)
			}
		})

		state.eventSource.addEventListener('log', (event) => {
			const entry = JSON.parse((event as MessageEvent).data) as LogEntry
			state.logs = [...state.logs, entry]
		})

		state.eventSource.addEventListener('issue', (event) => {
			const entry = JSON.parse((event as MessageEvent).data) as ErrorEntry
			state.errors = [...state.errors, entry]
		})
	}

	const loadErrors = async (id: string) => {
		const response = await fetch(`/api/broadcast/status?id=${id}&includeErrors=1`)
		if (!response.ok) return
		const data = (await response.json()) as { errors?: ErrorEntry[] }
		state.errors = data.errors ?? []
	}

	const clampDelay = () => {
		if (state.delayMs < MIN_DELAY) state.delayMs = MIN_DELAY
	}

	const uploadMedia = async (files: FileList | null) => {
		if (!files || files.length === 0) return
		state.isUploadingMedia = true
		state.errorMessage = ''

		try {
			const form = new FormData()
			if (state.draftId) form.set('draftId', state.draftId)
			const fileArray = Array.from(files)
			for (const file of fileArray) {
				form.append('media', file)
			}

			const response = await fetch('/api/broadcast/media', {
				method: 'POST',
				body: form,
			})
			const data = await response.json()
			if (!response.ok) {
				state.errorMessage = `Ошибка загрузки: ${data.error ?? 'UNKNOWN'}`
				return
			}

			state.draftId = data.draftId
			state.mediaItems = data.items.map((item: any, index: number) => ({
				key: item.key,
				name: item.name,
				type: item.type,
				size: item.size,
				previewUrl: URL.createObjectURL(fileArray[index]),
			}))
		} catch (error) {
			state.errorMessage = error instanceof Error ? error.message : 'Не удалось загрузить медиа'
		} finally {
			state.isUploadingMedia = false
		}
	}

	const clearMedia = async () => {
		if (!state.draftId) return
		await fetch('/api/broadcast/media', {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ draftId: state.draftId }),
		})
		state.mediaItems.forEach((item) => URL.revokeObjectURL(item.previewUrl))
		state.mediaItems = []
		state.draftId = null
	}

	const startBroadcast = async () => {
		state.errorMessage = ''
		state.isSubmitting = true
		state.logs = []
		state.errors = []
		state.status = null

		try {
			const form = new FormData()
			form.set('mode', state.mode)
			form.set('messageHtml', state.messageHtml)
			form.set('delayMs', String(state.delayMs))
			if (state.draftId) form.set('draftId', state.draftId)
			if (state.mediaItems.length) {
				form.set('mediaKeys', state.mediaItems.map((item) => item.key).join(','))
			}

			if (state.mode === 'csv' && state.contactsFile) {
				form.set('contactsFile', state.contactsFile)
			}
			if (state.mode === 'single') {
				form.set('singleId', state.singleId)
			}
			if (state.mode === 'manual') {
				form.set('manualList', state.manualList)
			}

			const response = await fetch('/api/broadcast/start', {
				method: 'POST',
				body: form,
			})

			const data = await response.json()
			if (!response.ok) {
				state.errorMessage = `Ошибка запуска: ${data.error ?? 'UNKNOWN'}`
				return
			}

			state.broadcastId = data.broadcastId
			attachSse(state.broadcastId)
			state.step = 3
		} catch (error) {
			state.errorMessage = error instanceof Error ? error.message : 'Не удалось запустить рассылку'
		} finally {
			state.isSubmitting = false
		}
	}

	const stopBroadcast = async () => {
		if (!state.broadcastId) return
		await fetch('/api/broadcast/stop', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id: state.broadcastId }),
		})
	}

	const resumeBroadcast = async () => {
		if (!state.broadcastId) return
		state.errorMessage = ''
		const response = await fetch('/api/broadcast/resume', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id: state.broadcastId }),
		})
		if (!response.ok) {
			const data = await response.json()
			state.errorMessage = `Ошибка продолжения: ${data.error ?? 'UNKNOWN'}`
			return
		}
		attachSse(state.broadcastId)
	}

	const toggleLink = () => {
		if (!state.editor) return
		const previousUrl = state.editor.getAttributes('link').href as string | undefined
		const url = window.prompt('URL', previousUrl ?? '')
		if (url === null) return
		if (url.trim() === '') {
			state.editor.chain().focus().unsetLink().run()
			return
		}
		state.editor.chain().focus().setLink({ href: url }).run()
	}

	interface EditorParams {
		onReady?: (editor: Editor) => void
		content?: string
	}

	const editorAction: Action<HTMLDivElement, EditorParams> = (node, params) => {
		const editor = new Editor({
			element: node,
			extensions: [
				StarterKit.configure({
					bold: true,
					italic: true,
					strike: true,
					code: true,
					blockquote: true,
					bulletList: true,
					orderedList: true,
					hardBreak: true,
				}),
				Underline,
				Link.configure({ openOnClick: false }),
				Spoiler,
			],
			content: params?.content ?? '',
			onUpdate: ({ editor }) => {
				state.messageHtml = editor.getHTML()
			},
			editorProps: {
				attributes: {
					'data-placeholder': 'Введите текст рассылки…',
				},
			},
		})

		params?.onReady?.(editor)

		return {
			update: (nextParams) => {
				if (nextParams?.content !== undefined) {
					const current = editor.getHTML()
					if (current !== nextParams.content) {
						editor.commands.setContent(nextParams.content, false)
					}
				}
			},
			destroy: () => {
				editor.destroy()
				state.editor = null
			},
		}
	}

	const onBackClick = () => {
		if (state.step > 1) state.step -= 1
	}

	const onNextClick = () => {
		if (state.step === 1) state.step = 2
	}

	const onStartClick = () => {
		void startBroadcast()
	}

	const onStopClick = () => {
		void stopBroadcast()
	}

	const onResumeClick = () => {
		void resumeBroadcast()
	}

	const onFileChange = (event: Event) => {
		const target = event.currentTarget as HTMLInputElement
		void uploadMedia(target.files)
	}

	const onCsvChange = (event: Event) => {
		const target = event.currentTarget as HTMLInputElement
		state.contactsFile = target.files?.[0] ?? null
		void computeFileStats()
	}

	const onManualInput = (event: Event) => {
		const target = event.currentTarget as HTMLTextAreaElement
		state.manualList = target.value
	}

	const onSingleInput = (event: Event) => {
		const target = event.currentTarget as HTMLInputElement
		state.singleId = target.value
	}

	const onDelayInput = (event: Event) => {
		const target = event.currentTarget as HTMLInputElement
		state.delayMs = Number(target.value)
		clampDelay()
	}

	const onModeChange = (event: Event) => {
		const target = event.currentTarget as HTMLInputElement
		state.mode = target.value as Mode
	}

	const onReady = (editor: Editor) => {
		state.editor = editor
	}

	const computeFileStats = async () => {
		if (!state.contactsFile) {
			state.fileStats = null
			return
		}
		const text = await state.contactsFile.text()
		const lines = text.split(/\r?\n/).map((line) => line.trim())
		const nonEmpty = lines.filter((line) => line.length > 0)
		const unique = new Set(nonEmpty)
		state.fileStats = {
			total: lines.length,
			nonEmpty: nonEmpty.length,
			unique: unique.size,
			duplicates: Math.max(0, nonEmpty.length - unique.size),
		}
	}

	const onBoldClick = () => {
		state.editor?.chain().focus().toggleBold().run()
	}

	const onItalicClick = () => {
		state.editor?.chain().focus().toggleItalic().run()
	}

	const onUnderlineClick = () => {
		state.editor?.chain().focus().toggleUnderline().run()
	}

	const onStrikeClick = () => {
		state.editor?.chain().focus().toggleStrike().run()
	}

	const onCodeClick = () => {
		state.editor?.chain().focus().toggleCode().run()
	}

	const onSpoilerClick = () => {
		state.editor?.chain().focus().toggleSpoiler().run()
	}

	const onQuoteClick = () => {
		state.editor?.chain().focus().toggleBlockquote().run()
	}

	const onResetClick = () => {
		state.editor?.chain().focus().unsetAllMarks().clearNodes().run()
	}

	const onLinkClick = () => {
		toggleLink()
	}

	$effect(() => {
		if (!isBrowser) return
		const stateValue = state.status?.state
		if ((stateValue === 'completed' || stateValue === 'stopped') && state.broadcastId) {
			void loadErrors(state.broadcastId)
		}
	})

	$effect(() => {
		if (!isBrowser) return
		const current = state.eventSource
		return () => {
			current?.close()
		}
	})
</script>

<section class="space-y-3">
	<h1 class="h1">Рассылка</h1>
	<p class="body-l max-w-2xl text-text-muted">
		Управление рассылкой через веб-интерфейс: загрузка базы, медиа, текст и прогресс.
	</p>
</section>

<section class="card">
	<div class="flex flex-wrap items-center justify-between gap-4">
		<div class="flex items-center gap-3">
			<span class={`badge ${state.step === 1 ? 'text-text' : ''}`}>1. База</span>
			<span class={`badge ${state.step === 2 ? 'text-text' : ''}`}>2. Содержание</span>
			<span class={`badge ${state.step === 3 ? 'text-text' : ''}`}>3. Процесс</span>
		</div>
		<div class="flex gap-2">
			{#if state.step > 1}
				<button class="btn btn-secondary" onclick={onBackClick}>Назад</button>
			{/if}
			{#if state.step === 1}
				<button class="btn btn-primary" onclick={onNextClick}>Дальше</button>
			{:else if state.step === 2}
				<button class="btn btn-primary" onclick={onStartClick} disabled={state.isSubmitting}>
					{state.isSubmitting ? 'Запуск...' : 'Запустить'}
				</button>
			{/if}
		</div>
	</div>
</section>

{#if state.step === 1}
	<section class="grid gap-6 lg:grid-cols-3">
		<div class="card space-y-4 lg:col-span-2">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div>
					<p class="body-s uppercase tracking-wide text-text-muted">Аудитория</p>
					<h2 class="h2 mt-2">Кому отправить</h2>
				</div>
				<div class="badge">Только не заблокированные</div>
			</div>

			<div class="grid gap-4 md:grid-cols-2">
				<label class="flex items-center gap-3">
					<input type="radio" name="mode" value="manual" checked={state.mode === 'manual'} onchange={onModeChange} />
					<span class="body-m">Ручной список</span>
				</label>
				<label class="flex items-center gap-3">
					<input type="radio" name="mode" value="csv" checked={state.mode === 'csv'} onchange={onModeChange} />
					<span class="body-m">Загрузка через файл</span>
				</label>
				<label class="flex items-center gap-3">
					<input type="radio" name="mode" value="single" checked={state.mode === 'single'} onchange={onModeChange} />
					<span class="body-m">Один контакт</span>
				</label>
				<label class="flex items-center gap-3">
					<input type="radio" name="mode" value="all" checked={state.mode === 'all'} onchange={onModeChange} />
					<span class="body-m">Все пользователи</span>
				</label>
			</div>

			{#if state.mode === 'manual'}
				<div>
					<label class="body-s text-text-muted" for="manual">Список ID (каждый в новой строке)</label>
					<textarea
						class="input mt-2 min-h-40"
						id="manual"
						value={state.manualList}
						oninput={onManualInput}
						placeholder={`123456789\n987654321`}
					></textarea>
				</div>
			{/if}

			{#if state.mode === 'csv'}
				<div>
					<label class="body-s text-text-muted" for="csv">Текстовый файл с ID (каждый на новой строке)</label>
					<input
						class="input mt-2"
						id="csv"
						type="file"
						accept=".txt,text/plain"
						onchange={onCsvChange}
					/>
					<p class="input-help mt-2">Формат: каждый telegramId в отдельной строке.</p>
					{#if state.fileStats}
						<div class="mt-3 rounded-md border border-border bg-surface-2 p-3 text-sm">
							<p class="text-text">Всего строк: {state.fileStats.total}</p>
							<p class="text-text">Непустых: {state.fileStats.nonEmpty}</p>
							<p class="text-text">Уникальных: {state.fileStats.unique}</p>
							<p class="text-text">Дубликатов: {state.fileStats.duplicates}</p>
						</div>
					{/if}
				</div>
			{/if}

			{#if state.mode === 'single'}
				<div>
					<label class="body-s text-text-muted" for="single">Telegram ID</label>
					<input
						class="input mt-2"
						id="single"
						value={state.singleId}
						oninput={onSingleInput}
						placeholder="123456789"
					/>
				</div>
			{/if}

			{#if state.mode === 'all'}
				<p class="body-s text-text-muted">
					Отправка всем пользователям, которые не заблокировали бота.
				</p>
			{/if}
		</div>

		<div class="card space-y-4">
			<p class="body-s uppercase tracking-wide text-text-muted">Настройки</p>
			<div>
				<label class="body-s text-text-muted" for="delay">Задержка между сообщениями (мс)</label>
				<input
					class="mt-2 w-full"
					id="delay"
					type="range"
					min="50"
					max="2000"
					step="50"
					value={state.delayMs}
					oninput={onDelayInput}
				/>
				<p class="input-help mt-2">
					Текущая задержка: {state.delayMs} мс.
				</p>

				<p class="input-help mt-2">
					Скорость: {speedLabel}.
				</p>
			</div>
		</div>
	</section>
{/if}

{#if state.step === 2}
	<section class="grid gap-6">
		<div class="card space-y-8">
			<div>
				<h2 class="h2">Содержание рассылки</h2>
			</div>

			<div class="space-y-3">
				<div class="flex items-center justify-between">
					<div>
						<h3 class="h3">Медиа вложения</h3>
					</div>
					{#if state.mediaItems.length > 0}
						<button class="btn btn-ghost" onclick={clearMedia}>Очистить</button>
					{/if}
				</div>
				<input
					class="input"
					type="file"
					multiple
					accept="image/*,video/*"
					onchange={onFileChange}
					disabled={state.isUploadingMedia}
				/>
				<p class="input-help">До 10 файлов. Храним временно и отправляем как альбом.</p>

				{#if state.mediaItems.length > 0}
					<div class="grid gap-3 sm:grid-cols-2">
						{#each state.mediaItems as item}
							<div class="rounded-md border border-border bg-surface-2 p-3">
								{#if item.type === 'photo'}
									<img src={item.previewUrl} alt={item.name} class="h-32 w-full rounded-md object-cover" />
								{:else}
									<video src={item.previewUrl} class="h-32 w-full rounded-md object-cover" controls>
										<track kind="captions" />
									</video>
								{/if}
								<p class="body-s mt-2 text-text-muted">{item.name}</p>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<div class="space-y-3">
				<div>
					<h3 class="h3">Текст рассылки</h3>
				</div>
				<div class="rounded-md border border-border bg-surface p-3">
					<div class="editor-toolbar flex flex-wrap items-center gap-1 rounded-md border border-border bg-surface-2 p-2 text-sm">
						<button
							class={`btn btn-ghost ${state.editor?.isActive('bold') ? 'text-accent' : ''}`}
							onclick={onBoldClick}
						>
							Жирный
						</button>
						<span class="h-5 w-px bg-border"></span>
						<button
							class={`btn btn-ghost ${state.editor?.isActive('italic') ? 'text-accent' : ''}`}
							onclick={onItalicClick}
						>
							Курсив
						</button>
						<span class="h-5 w-px bg-border"></span>
						<button
							class={`btn btn-ghost ${state.editor?.isActive('underline') ? 'text-accent' : ''}`}
							onclick={onUnderlineClick}
						>
							Подчёркнутый
						</button>
						<span class="h-5 w-px bg-border"></span>
						<button
							class={`btn btn-ghost ${state.editor?.isActive('strike') ? 'text-accent' : ''}`}
							onclick={onStrikeClick}
						>
							Зачёркнутый
						</button>
						<span class="h-5 w-px bg-border"></span>
						<button
							class={`btn btn-ghost ${state.editor?.isActive('code') ? 'text-accent' : ''}`}
							onclick={onCodeClick}
						>
							Моно
						</button>
						<span class="h-5 w-px bg-border"></span>
						<button
							class={`btn btn-ghost ${state.editor?.isActive('spoiler') ? 'text-accent' : ''}`}
							onclick={onSpoilerClick}
						>
							Скрытый
						</button>
						<span class="h-5 w-px bg-border"></span>
						<button
							class={`btn btn-ghost ${state.editor?.isActive('blockquote') ? 'text-accent' : ''}`}
							onclick={onQuoteClick}
						>
							Цитата
						</button>
						<span class="h-5 w-px bg-border"></span>
						<button
							class={`btn btn-ghost ${state.editor?.isActive('link') ? 'text-accent' : ''}`}
							onclick={onLinkClick}
						>
							Ссылка
						</button>
						<span class="h-5 w-px bg-border"></span>
						<button class="btn btn-ghost" onclick={onResetClick}>
							Сбросить
						</button>
					</div>
					<div class="mt-3 prose-editor min-h-55" use:editorAction={{ onReady, content: state.messageHtml }}></div>
				</div>
				<p class="input-help">Горячие клавиши: Ctrl/Cmd+B, I, U. Ссылка добавляется через кнопку.</p>
				{#if state.errorMessage}
					<p class="body-s text-warning">{state.errorMessage}</p>
				{/if}
			</div>
		</div>
	</section>
{/if}

{#if state.step === 3}
	<section class="grid gap-6 lg:grid-cols-3">
		<div class="card space-y-4 lg:col-span-2">
			<div class="flex items-center justify-between">
				<div>
					<p class="body-s uppercase tracking-wide text-text-muted">Процесс</p>
					<h2 class="h2 mt-2">Прогресс</h2>
				</div>
				{#if state.status?.state === 'stopped'}
					<button class="btn btn-primary" onclick={onResumeClick}>Продолжить</button>
				{/if}
			</div>

			<div class="space-y-3">
				<div class="h-2 w-full overflow-hidden rounded-full bg-surface-2">
					<div class="h-full bg-accent" style={`width: ${progressValue}%`}></div>
				</div>
				<p class="body-s text-text-muted">Прогресс: {progressValue}%</p>
			</div>

			<div class="grid gap-2">
				<p class="body-m">Состояние: <span class="text-text-muted">{state.status?.state ?? '—'}</span></p>
				<p class="body-m">ID: <span class="text-text-muted">{state.broadcastId ?? '—'}</span></p>
				<p class="body-m">Создано: <span class="text-text-muted">{formatDate(state.status?.createdAt)}</span></p>
				<p class="body-m">Старт: <span class="text-text-muted">{formatDate(state.status?.startedAt)}</span></p>
				<p class="body-m">Финиш: <span class="text-text-muted">{formatDate(state.status?.finishedAt)}</span></p>
			</div>
		</div>

		<div class="card space-y-4">
			<p class="body-s uppercase tracking-wide text-text-muted">Счетчики</p>
			<div class="grid gap-2">
				<p class="body-m">Всего: <span class="text-text-muted">{state.status?.total ?? 0}</span></p>
				<p class="body-m">Успешно: <span class="text-text-muted">{state.status?.success ?? 0}</span></p>
				<p class="body-m">Ошибки: <span class="text-text-muted">{state.status?.failed ?? 0}</span></p>
				<p class="body-m">Пропущено: <span class="text-text-muted">{state.status?.skipped ?? 0}</span></p>
			</div>
			
		</div>
	</section>

	<section class="grid gap-6 lg:grid-cols-2">
		<div class="card space-y-4">
			<p class="body-s uppercase tracking-wide text-text-muted">Консоль</p>
			<div class="max-h-72 space-y-2 overflow-y-auto rounded-md border border-border bg-surface-2 p-4 text-sm">
				{#if state.logs.length === 0}
					<p class="text-text-muted">Логи появятся после старта рассылки.</p>
				{:else}
					{#each state.logs as log}
						<div class={`text-text ${log.level === 'error' ? 'text-warning' : ''}`}>
							<span class="text-text-muted">[{new Date(log.ts).toLocaleTimeString('ru-RU')}]</span>
							<span class="ml-2">{log.message}</span>
						</div>
					{/each}
				{/if}
			</div>
		</div>

		<div class="card space-y-4">
			<p class="body-s uppercase tracking-wide text-text-muted">Ошибки</p>
			{#if state.errors.length === 0}
				<p class="body-s text-text-muted">Полный список ошибок появится после завершения.</p>
			{:else}
				<div class="max-h-72 space-y-2 overflow-y-auto rounded-md border border-border bg-surface-2 p-4 text-sm">
					{#each state.errors as err}
						<div>
							<p class="text-text">
								<span class="text-text-muted">[{new Date(err.ts).toLocaleTimeString('ru-RU')}]</span>
								<span class="ml-2">{err.contactId}</span>
								<span class="ml-2 text-text-muted">{err.reason}</span>
							</p>
							{#if err.error}
								<p class="text-warning">{err.error}</p>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</section>
{/if}

<style>
	:global(.prose-editor) {
		cursor: text;
	}

	:global(.prose-editor .ProseMirror) {
		min-height: 220px;
		outline: none;
		color: var(--color-text);
		font-family: var(--font-sans-alt);
		font-size: 1rem;
		line-height: 1.6;
	}

	:global(.prose-editor .ProseMirror p) {
		margin: 0 0 0.75rem 0;
	}

	:global(.prose-editor .ProseMirror p:last-child) {
		margin-bottom: 0;
	}

	:global(.prose-editor .ProseMirror strong) {
		font-weight: 600;
	}

	:global(.prose-editor .ProseMirror ul),
	:global(.prose-editor .ProseMirror ol) {
		padding-left: 1.25rem;
	}

	:global(.prose-editor .ProseMirror a) {
		color: var(--color-accent);
		text-decoration: underline;
		text-decoration-thickness: 2px;
		text-underline-offset: 2px;
	}

	:global(.prose-editor .ProseMirror blockquote) {
		border-left: 3px solid var(--color-border);
		padding-left: 12px;
		color: var(--color-text-muted);
		margin: 0 0 1rem 0;
	}

	:global(.prose-editor .ProseMirror.is-empty::before) {
		content: attr(data-placeholder);
		color: var(--color-text-muted);
		float: left;
		pointer-events: none;
		height: 0;
	}

	:global(.prose-editor .tg-spoiler) {
		background: rgba(246, 247, 249, 0.18);
		color: transparent;
		border-radius: 6px;
		padding: 0 4px;
	}

	:global(.prose-editor .tg-spoiler::selection) {
		color: var(--color-text);
	}

	:global(.prose-editor .tg-spoiler:hover) {
		color: var(--color-text);
	}

	:global(.editor-toolbar .btn) {
		padding: 6px 10px;
		font-size: 0.75rem;
		line-height: 1.1;
	}
</style>
