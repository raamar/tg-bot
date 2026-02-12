import { redis } from '../redis'

export type PartnerSession =
  | { action: 'SET_WALLET' }
  | { action: 'WITHDRAW_AMOUNT' }
  | { action: 'REF_NAME_CREATE'; referralId: string }
  | { action: 'REF_CREATE_MANUAL_CODE' }
  | { action: 'REF_NAME_EDIT'; referralId: string }
  | { action: 'ADMIN_REJECT_REASON'; withdrawalId: string }
  | { action: 'ADMIN_APPROVE_LINK'; withdrawalId: string }
  | { action: 'ADMIN_RATE_REF_CODE' }
  | { action: 'ADMIN_RATE_REF_VALUE'; referralId: string }

const sessionKey = (telegramId: string) => `partnerbot:session:${telegramId}`

export const getSession = async (telegramId: string): Promise<PartnerSession | null> => {
  const raw = await redis.get(sessionKey(telegramId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as PartnerSession
  } catch {
    return null
  }
}

export const setSession = async (telegramId: string, session: PartnerSession): Promise<void> => {
  await redis.set(sessionKey(telegramId), JSON.stringify(session))
}

export const clearSession = async (telegramId: string): Promise<void> => {
  await redis.del(sessionKey(telegramId))
}
