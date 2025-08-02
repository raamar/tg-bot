// src/actions/admin.ts
import { Markup } from 'telegraf'
import { redis } from '../redis'
import { AdminActionHandlerMap, BroadcastSession, CallbackContext, PhotoContext, TextContext } from '../types/admin'
import { broadcastQueue } from '../broadcast'
import { processContactsFile } from '../helpers/fileProcessor'
import { bot } from '.'
import { restoreHtmlFromEntities } from '../helpers/restoreHtmlFromEntities'
import { isAdmin } from '../helpers/isAdmin'
import { prisma } from '../prisma'
import { generateUserExcelBuffer } from '../helpers/exportToExcel'
import { funnelQueue } from '../funnel'
import { funnelMessages } from '../config'

const getSession = async (ctx: { from?: { id: number } }): Promise<BroadcastSession | null> => {
  if (!ctx.from) return null
  const sessionRaw = await redis.get(`admin:${ctx.from.id}:broadcast`)
  return sessionRaw ? JSON.parse(sessionRaw) : null
}

const updateSession = async (ctx: { from?: { id: number } }, session: BroadcastSession): Promise<void> => {
  if (!ctx.from) return
  await redis.set(`admin:${ctx.from.id}:broadcast`, JSON.stringify(session))
}

const showMainMenu = async (
  ctx: TextContext | CallbackContext | PhotoContext,
  session: BroadcastSession
): Promise<void> => {
  const message = [
    `📊 <b>Рассылка</b>`,
    `👥 Контактов: ${session.contacts.length}`,
    `📝 Текст: ${session.text ? '✅' : '❌'}`,
    `🖼 Фото: ${session.photoFileId ? '✅' : '❌'}`,
    ``,
    `Выберите действие:`,
  ].join('\n')

  const photoButtonText = session.photoFileId ? '🖼 Изменить фото' : '➕ Добавить фото'

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✏️ Изменить текст', 'broadcast:edit_text'),
      Markup.button.callback(photoButtonText, 'broadcast:edit_photo'),
    ],
    [
      Markup.button.callback('🚀 Начать рассылку', 'broadcast:start'),
      Markup.button.callback('❌ Отменить', 'broadcast:cancel'),
    ],
  ])

  if (session.photoFileId) {
    await ctx.replyWithPhoto(session.photoFileId)
  }

  await ctx.replyWithHTML(message, keyboard)
}

const startBroadcasting = async (ctx: TextContext | CallbackContext, session: BroadcastSession): Promise<void> => {
  if (!session.text) {
    await ctx.reply('Текст рассылки не может быть пустым')
    return
  }

  await broadcastQueue.add('send', {
    adminId: ctx.from.id,
    contacts: session.contacts,
    text: session.text,
    photoFileId: session.photoFileId,
  })

  await redis.del(`admin:${ctx.from.id}:broadcast`)
  await ctx.reply(`Рассылка запущена.`)
}

const adminActions: AdminActionHandlerMap = {
  commands: {
    broadcast: async (ctx) => {
      if (!isAdmin(ctx.from?.id)) {
        await ctx.reply('У вас нет прав для выполнения этой команды')
        return
      }

      await ctx.reply('Пожалуйста, загрузите файл с контактами (каждый ID на новой строке)')

      await redis.set(
        `admin:${ctx.from?.id}:broadcast`,
        JSON.stringify({
          step: 'AWAIT_FILE',
          contacts: [],
        } as BroadcastSession)
      )
    },

    stop: async (ctx) => {
      const telegramId = String(ctx?.from?.id)

      const user = await prisma.user.update({
        where: { telegramId },
        select: { id: true },
        data: {
          funnelProgress: {
            update: {
              nextJobId: null,
              nextRunAt: null,
            },
          },
        },
      })

      if (!user) {
        return
      }

      const result = await Promise.allSettled(
        funnelMessages.map(async ({ id: stageId }) => {
          try {
            const job = await funnelQueue.getJob(`funnel-${user.id}-${stageId}`)
            if (job) {
              return await job.remove()
            }

            return Promise.reject()
          } catch (error) {
            let message = error
            if (error instanceof Error) {
              message = error.message
            }

            console.error('ОШИБКА ПРИ /stop:', message)

            return Promise.reject()
          }
        })
      )

      const actionKeyPattern = `user:${telegramId}:action:*`
      const actionKeys = await redis.keys(actionKeyPattern)
      if (actionKeys.length > 0) {
        await redis.del(...actionKeys)
      }

      if (result.filter((item) => item.status === 'fulfilled').length > 0) {
        ctx.reply('Вы остановили рассылку.')
        return
      }

      ctx.reply('Вы не учавствуете в рассылке')
    },

    export: async (ctx) => {
      if (!isAdmin(ctx.from?.id)) {
        await ctx.reply('У вас нет прав для выполнения этой команды')
        return
      }

      await ctx.reply('⏳ Экспорт данных, пожалуйста подождите...')

      const users = await prisma.user.findMany({
        include: {
          funnelProgress: true,
          payments: true,
        },
        orderBy: {
          createdAt: 'asc',
        },
      })

      const buffer = await generateUserExcelBuffer(users)

      await ctx.replyWithDocument({
        source: buffer,
        filename: `users_export_${new Date().toISOString().slice(0, 10)}.xlsx`,
      })
    },
  },

  messages: {
    text: async (ctx) => {
      const session = await getSession(ctx)
      if (!session || session.step !== 'AWAIT_TEXT') return

      session.text = restoreHtmlFromEntities(ctx.message.text, ctx.message.entities ?? [])
      session.step = 'MAIN_MENU'
      await updateSession(ctx, session)

      await showMainMenu(ctx, session)
    },
    document: async (ctx) => {
      const session = await getSession(ctx)
      if (!session || session.step !== 'AWAIT_FILE') return

      if (!('document' in ctx.message)) {
        await ctx.reply('Пожалуйста, загрузите файл с контактами')
        return
      }

      const doc = ctx.message.document

      if (!doc.file_name?.endsWith('.txt')) {
        await ctx.reply('❌ Файл должен иметь расширение .txt')
        return
      }

      if (doc.mime_type !== 'text/plain') {
        await ctx.reply('❌ Неподдерживаемый тип файла. Ожидается текстовый файл')
        return
      }

      const MAX_FILE_SIZE = 1024 * 1024 // 1MB
      if (doc.file_size && doc.file_size > MAX_FILE_SIZE) {
        await ctx.reply(`❌ Файл слишком большой (${(doc.file_size / 1024).toFixed(2)}KB). Максимум 1MB`)
        return
      }

      let contacts = await processContactsFile(bot, doc.file_id)

      if (contacts.length === 0) {
        await ctx.reply('❌ Файл не содержит валидных контактов. Формат: каждый ID на новой строке')
        return
      }

      const MAX_CONTACTS = 10000
      if (contacts.length > MAX_CONTACTS) {
        await ctx.reply(`❌ Слишком много контактов (${contacts.length}). Максимум ${MAX_CONTACTS}`)
        return
      }

      const uniqueContacts = [...new Set(contacts)]
      if (uniqueContacts.length !== contacts.length) {
        await ctx.reply(`⚠️ Удалено ${contacts.length - uniqueContacts.length} дубликатов`)
        contacts = uniqueContacts
      }

      session.contacts = contacts
      session.step = 'AWAIT_TEXT'
      await updateSession(ctx, session)

      await ctx.reply(`✅ Загружено ${contacts.length} контактов. Теперь отправьте текст для рассылки:`)
    },
    photo: async (ctx) => {
      const session = await getSession(ctx)
      if (!session || session.step !== 'AWAIT_PHOTO') return

      session.photoFileId = ctx.message.photo[ctx.message.photo.length - 1].file_id
      session.step = 'MAIN_MENU'
      await updateSession(ctx, session)

      await showMainMenu(ctx, session)
    },
  },

  callbacks: {
    'broadcast:edit_text': async (ctx) => {
      const session = await getSession(ctx)
      if (!session || session.step !== 'MAIN_MENU') return

      session.step = 'AWAIT_TEXT'
      await updateSession(ctx, session)
      await ctx.reply('Введите новый текст для рассылки:')
      await ctx.answerCbQuery()
    },

    'broadcast:edit_photo': async (ctx) => {
      const session = await getSession(ctx)
      if (!session || session.step !== 'MAIN_MENU') return

      session.step = 'AWAIT_PHOTO'
      await updateSession(ctx, session)
      await ctx.reply('Отправьте новое фото для рассылки:')
      await ctx.answerCbQuery()
    },

    'broadcast:start': async (ctx) => {
      const session = await getSession(ctx)
      if (!session || session.step !== 'MAIN_MENU') return

      await startBroadcasting(ctx, session)
      await ctx.answerCbQuery()
    },

    'broadcast:cancel': async (ctx) => {
      await redis.del(`admin:${ctx.from.id}:broadcast`)
      await ctx.reply('Рассылка отменена')
      await ctx.answerCbQuery()
    },
  },
}

export { adminActions }
