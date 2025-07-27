import { Context, NarrowedContext } from 'telegraf'
import { CallbackQuery, Update } from 'telegraf/typings/core/types/typegram'

export type SendActionType = 'BUY_LINK' | 'SUBSCRIBE' | 'START' | 'CONTENTS' | 'START_FUNNEL' | 'DEFAULT'

interface InlineButtonBase {
  text: string
  action: SendActionType
}

export type InlineButton =
  | (InlineButtonBase & { action: 'BUY_LINK'; amount: number; url?: string })
  | (InlineButtonBase & { action: 'START' })
  | (InlineButtonBase & { action: 'CONTENTS' })
  | (InlineButtonBase & { action: 'START_FUNNEL' })
  | (InlineButtonBase & { action: 'SUBSCRIBE' })

export type FunnelMessage = {
  id: string
  delayMs: number
  text: string
  buttons: InlineButton[]
  photoUrl?: string
  stop?: boolean
}

export type ActionMessage = Omit<FunnelMessage, 'delayMs' | 'id'>

export type ActionHandlerMap = {
  DEFAULT: (ctx: NarrowedContext<Context, Update.CallbackQueryUpdate<CallbackQuery>>) => Promise<void>
} & {
  [K in Exclude<SendActionType, 'START'>]?: (
    ctx: NarrowedContext<Context, Update.CallbackQueryUpdate<CallbackQuery>>
  ) => Promise<void>
}

export type FunnelQueuePayload = {
  userId: string
  stageIndex: number
}
