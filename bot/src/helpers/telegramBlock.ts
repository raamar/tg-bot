// bot/src/helpers/telegramBlock.ts

export type TelegramBlockInfo = {
  isBlocked: boolean
  reason?: string
  errorCode?: number
}

const getErrObj = (e: unknown): Record<string, any> | null => {
  if (typeof e !== 'object' || e === null) return null
  return e as Record<string, any>
}

export const getTelegramErrorCode = (e: unknown): number | undefined => {
  const obj = getErrObj(e)
  if (!obj) return undefined
  const code = typeof obj.code === 'number' ? obj.code : undefined
  const resp = obj.response as Record<string, any> | undefined
  const status =
    typeof resp?.error_code === 'number' ? resp.error_code : typeof resp?.status === 'number' ? resp.status : undefined
  return code ?? status
}

export const getTelegramErrorDescription = (e: unknown): string | undefined => {
  const obj = getErrObj(e)
  if (!obj) return undefined
  const resp = obj.response as Record<string, any> | undefined
  const desc = typeof resp?.description === 'string' ? resp.description : undefined
  const msg = typeof obj.message === 'string' ? obj.message : undefined
  return desc ?? msg
}

/**
 * Telegram не даёт "isBlocked()", поэтому ловим косвенно по ошибкам.
 * Самые частые:
 *  - 403: Forbidden: bot was blocked by the user
 *  - 403: Forbidden: user is deactivated
 *  - 400: Bad Request: chat not found
 */
export const getTelegramBlockInfo = (e: unknown): TelegramBlockInfo => {
  const code = getTelegramErrorCode(e)
  const desc = (getTelegramErrorDescription(e) ?? '').toLowerCase()

  const blocked =
    (code === 403 && desc.includes('bot was blocked by the user')) ||
    (code === 403 && desc.includes('user is deactivated')) ||
    (code === 400 && desc.includes('chat not found'))

  return {
    isBlocked: blocked,
    reason: blocked ? getTelegramErrorDescription(e) : undefined,
    errorCode: code,
  }
}
