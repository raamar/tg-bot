import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'

const MAX_VIDEO_NOTE_DURATION_SEC = 60
const FF_EXEC_TIMEOUT_MS = 90_000

interface ProbeResult {
	durationSec: number
	width: number
	height: number
	codecName: string
}

const runCommand = async (bin: string, args: string[]) => {
	return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		execFile(bin, args, { timeout: FF_EXEC_TIMEOUT_MS }, (error, stdout, stderr) => {
			if (error) {
				reject(
					Object.assign(error, {
						stdout: String(stdout ?? ''),
						stderr: String(stderr ?? ''),
					}),
				)
				return
			}
			resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
		})
	})
}

const probeVideo = async (path: string): Promise<ProbeResult> => {
	let stdout = ''
	try {
		const result = await runCommand('ffprobe', [
			'-v',
			'error',
			'-select_streams',
			'v:0',
			'-show_entries',
			'stream=width,height,codec_name',
			'-show_entries',
			'format=duration',
			'-of',
			'json',
			path,
		])
		stdout = result.stdout
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (message.includes('ENOENT') || message.includes('not found')) {
			throw new Error('FFMPEG_NOT_AVAILABLE')
		}
		throw new Error('VIDEO_NOTE_PROBE_FAILED')
	}

	try {
		const parsed = JSON.parse(stdout) as {
			streams?: Array<{ width?: number; height?: number; codec_name?: string }>
			format?: { duration?: string }
		}
		const stream = parsed.streams?.[0]
		const width = Number(stream?.width ?? 0)
		const height = Number(stream?.height ?? 0)
		const durationSec = Number(parsed.format?.duration ?? 0)
		const codecName = String(stream?.codec_name ?? '').toLowerCase()

		if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
			throw new Error('VIDEO_NOTE_UNSUPPORTED')
		}

		return {
			durationSec: Number.isFinite(durationSec) ? durationSec : 0,
			width,
			height,
			codecName,
		}
	} catch (error) {
		if (error instanceof Error && error.message === 'VIDEO_NOTE_UNSUPPORTED') {
			throw error
		}
		throw new Error('VIDEO_NOTE_PROBE_FAILED')
	}
}

const needsTranscode = (mime: string, meta: ProbeResult) => {
	if (meta.durationSec <= 0 || meta.durationSec > MAX_VIDEO_NOTE_DURATION_SEC) return true
	if (meta.width !== meta.height) return true
	if (mime !== 'video/mp4') return true
	if (meta.codecName !== 'h264') return true
	return false
}

export const prepareVideoNoteMedia = async (input: { path: string; mime: string; name: string }) => {
	const meta = await probeVideo(input.path)
	if (meta.durationSec > MAX_VIDEO_NOTE_DURATION_SEC * 2) {
		throw new Error('VIDEO_NOTE_TOO_LONG')
	}

	if (!needsTranscode(input.mime, meta)) {
		return {
			path: input.path,
			name: input.name,
			mime: input.mime,
			transcoded: false,
			cleanup: async () => {},
		}
	}

	const outputExt = '.mp4'
	const outputBase = `${randomUUID()}-video-note`
	const outputPath = join(dirname(input.path), `${outputBase}${outputExt}`)
	const baseName = input.name.slice(0, Math.max(0, input.name.length - extname(input.name).length)) || 'video-note'
	const outputName = `${baseName}-video-note.mp4`

	try {
		await runCommand('ffmpeg', [
			'-y',
			'-i',
			input.path,
			'-vf',
			"crop='min(iw,ih)':'min(iw,ih)',scale=640:640:force_original_aspect_ratio=decrease,pad=640:640:(ow-iw)/2:(oh-ih)/2",
			'-t',
			String(MAX_VIDEO_NOTE_DURATION_SEC),
			'-c:v',
			'libx264',
			'-preset',
			'veryfast',
			'-crf',
			'23',
			'-pix_fmt',
			'yuv420p',
			'-c:a',
			'aac',
			'-b:a',
			'96k',
			'-movflags',
			'+faststart',
			outputPath,
		])
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (message.includes('ENOENT') || message.includes('not found')) {
			throw new Error('FFMPEG_NOT_AVAILABLE')
		}
		throw new Error('VIDEO_NOTE_TRANSCODE_FAILED')
	}

	return {
		path: outputPath,
		name: outputName,
		mime: 'video/mp4',
		transcoded: true,
		cleanup: async () => {
			try {
				await unlink(outputPath)
			} catch {
				// ignore
			}
		},
	}
}
