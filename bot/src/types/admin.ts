// src/types/admin.ts
import { Context, NarrowedContext } from 'telegraf'
import { Update, Message } from 'telegraf/typings/core/types/typegram'

// Базовые типы контекстов
export type TextContext = NarrowedContext<Context, Update.MessageUpdate<Message.TextMessage>>
export type DocumentContext = NarrowedContext<Context, Update.MessageUpdate<Message.DocumentMessage>>
export type PhotoContext = NarrowedContext<Context, Update.MessageUpdate<Message.PhotoMessage>>
export type CallbackContext = NarrowedContext<Context, Update.CallbackQueryUpdate>

// Типы обработчиков
type TextHandler = (ctx: TextContext) => Promise<void>
type DocumentHandler = (ctx: DocumentContext) => Promise<void>
type PhotoHandler = (ctx: PhotoContext) => Promise<void>
type CallbackHandler = (ctx: CallbackContext) => Promise<void>
type CommandHandler = (ctx: Context) => Promise<void>

// Тип для карты обработчиков
export type AdminActionHandlerMap = {
  // Обработчики команд
  commands: {
    broadcast: CommandHandler
    export: CommandHandler
    stop: CommandHandler
    paid: CommandHandler
  }

  // Обработчики сообщений
  messages: {
    text: TextHandler
    document: DocumentHandler
    photo: PhotoHandler
  }

  // Обработчики callback-запросов
  callbacks: {
    [key: string]: CallbackHandler
  }
}

export interface BroadcastSession {
  step: 'AWAIT_FILE' | 'AWAIT_TEXT' | 'MAIN_MENU' | 'AWAIT_PHOTO'
  contacts: string[]
  text?: string
  photoFileId?: string
}
