export type SendActionType = 'BUY_LINK' | 'SUBSCRIBE' | 'START' | 'CONTENTS' | 'START_FUNNEL'

interface InlineButtonBase {
  text: string
  action: SendActionType
}

export type InlineButton =
  | (InlineButtonBase & { action: 'BUY_LINK'; amount: number })
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
}

export type ActionMessage = Omit<FunnelMessage, 'delayMs' | 'id'>
