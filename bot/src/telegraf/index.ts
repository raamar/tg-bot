// bot/src/telegraf/index.ts

import { FmtString } from 'telegraf/format'
import { Worker, Job } from 'bullmq'
import { Update } from 'telegraf/typings/core/types/typegram'
import { Telegraf, Markup } from 'telegraf'
import telegrafThrottler from 'telegraf-throttler'

import { redis } from '../redis'
import { prisma } from '../prisma'
import { scenario } from '../scenario/config'
import { scheduleRemindersForStep, skipAllRemindersForUser } from '../reminders/scheduler'
import { enterStepForUser } from '../scenario/engine'
import { getLatestOfferInstance, ensureOfferInstanceStarted } from '../offers/engine'
import { scheduleOfferMessageExpiration } from '../offers/scheduler'
import { StepVisitSource, OfferStatus } from '@app/db'
import { SystemAction, OfferKey } from '../scenario/types'

import { adminActions } from './adminActions'
import { DocumentContext, PhotoContext, TextContext } from '../types/admin'
import { ensureWataPaymentLinkForOffer } from '../payments/ensureWataOfferPayment'
import { actionsMessages } from '../config'
import { inline_keyboard_generate } from '../helpers/inline_keyboard_generate'
import { hasJoinRequestsForAllRequiredChats } from '../helpers/hasJoinRequestsForAllRequiredChats'

import { getTelegramBlockInfo } from '../helpers/telegramBlock'
import { touchUserInteractionByTelegramId } from '../helpers/userInteraction'
import { initBlockCheckScheduler } from '../blockCheck/scheduler'
import '../blockCheck/worker'

if (process.env.TELEGRAM_TOKEN === undefined) {
  throw new Error('TELEGRAM_TOKEN is not defined')
}

if (process.env.TELEGRAM_WEBHOOK_URL === undefined) {
  throw new Error('TELEGRAM_WEBHOOK_URL is not defined')
}

export const bot = new Telegraf(process.env.TELEGRAM_TOKEN)
const webhookUrl = new URL(process.env.TELEGRAM_WEBHOOK_URL)

const throttler = telegrafThrottler({
  out: {
    minTime: 34,
    reservoir: 30,
    reservoirRefreshAmount: 30,
    reservoirRefreshInterval: 1000,
  },
})

bot.use(throttler)

const originalCallApi = (bot.telegram as any).callApi.bind(bot.telegram)

;(bot.telegram as any).callApi = async (method: string, payload: any, ...rest: any[]) => {
  try {
    return await originalCallApi(method, payload, ...rest)
  } catch (e) {
    const info = getTelegramBlockInfo(e)
    if (info.isBlocked) {
      const chatIdRaw = payload?.chat_id
      const chatIdStr = chatIdRaw != null ? String(chatIdRaw) : ''

      // не трогаем группы/каналы (chat_id отрицательные)
      const chatIdNum = Number(chatIdStr)
      const isUserChat = Number.isFinite(chatIdNum) && chatIdNum > 0

      if (isUserChat) {
        try {
          await prisma.user.updateMany({
            where: { telegramId: chatIdStr },
            data: {
              blockedByUser: true,
              blockedAt: new Date(),
              blockReason: info.reason ?? 'Blocked',
            },
          })
        } catch (dbErr) {
          console.warn('Не удалось пометить blockedByUser:', dbErr)
        }
      }
    }

    throw e
  }
}

const telegramWorker = new Worker<Update>(
  'telegram_bot1',
  async (job: Job<Update>) => {
    await bot.handleUpdate(job.data)
  },
  {
    concurrency: 100,
    connection: redis,
  },
)

telegramWorker.on('failed', async (job, err) => {
  console.error(`TELEGRAM UPDATE: Ошибка в задаче ${job?.id}:`, err.message)
})

bot.launch({
  webhook: {
    domain: webhookUrl.hostname,
    path: webhookUrl.pathname,
  },
})

const withErrorHandling = (handler: Parameters<typeof bot.action>[1]) => async (ctx: any, next: any) => {
  try {
    // @ts-ignore
    await handler(ctx, next)
  } catch (err) {
    let message: any = err
    if (err instanceof Error) {
      message = err.message
    }
    console.error(`Ошибка в обработчике action:`, message)
    await ctx.reply('Произошла ошибка, попробуйте позже.')
  }
}

const IS_PROD = process.env.NODE_ENV === 'production'
const MOSCOW_TZ = 'Europe/Moscow'

// ============== статичные ссылки из ТЗ ==============

const FOREIGN_FULL_URL = 'https://t.me/m/XGDbStMDNjYy' // Иностр. карта 10к
const FOREIGN_DISCOUNT_URL = 'https://t.me/m/mzVtb5_iZDY6' // Иностр. карта 5к

const CRYPTO_FULL_URL = 'https://t.me/m/DckHQcUiYTU6' // Крипта 10к
const CRYPTO_DISCOUNT_URL = 'https://t.me/m/gnlKrAHCMjIy' // Крипта 5к

// Для РФ оплаты теперь будем подставлять реальную ссылку из WATA,
// но оставляем заглушку на случай ошибок/не настроенного токена.
const RF_PAY_PLACEHOLDER_URL = 'https://example.com/pay-rf-card-placeholder'

function formatMoscow(date: Date): string {
  return date.toLocaleString('ru-RU', {
    timeZone: MOSCOW_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function getExternalPaymentUrls(instance: any) {
  const key = instance.offerKey as OfferKey
  const isDiscount = key.includes('main_discount_50') || key.includes('main_last_chance')

  return {
    foreignCardUrl: isDiscount ? FOREIGN_DISCOUNT_URL : FOREIGN_FULL_URL,
    cryptoUrl: isDiscount ? CRYPTO_DISCOUNT_URL : CRYPTO_FULL_URL,
  }
}

function buildOfferKeyboard(instance: any, ruCardUrl?: string) {
  const { foreignCardUrl, cryptoUrl } = getExternalPaymentUrls(instance)

  const rfUrl = ruCardUrl ?? RF_PAY_PLACEHOLDER_URL

  return Markup.inlineKeyboard([
    [
      Markup.button.url('Что внутри гайда', 'https://telegra.ph/CHto-tebya-zhdyot-vnutri-Gajda-10-07'),
      Markup.button.url('Отзывы', 'https://t.me/only_neuro_otzivi'),
    ],
    [Markup.button.url('Оплатить РФ картой', rfUrl)],
    [Markup.button.url('Оплатить не РФ картой', foreignCardUrl)],
    [Markup.button.url('Оплатить криптой', cryptoUrl)],
  ])
}

function buildOfferWindowText(instance: any): string {
  const amount = Number(instance.initialPrice || 0)
  const priceText = `${amount.toLocaleString('de-DE')}`
  const isShort = instance.offerKey.includes('main_last_chance') || instance.offerKey.includes('main_discount_50')

  if (isShort) {
    return ['👇 Выберите способ оплаты! 👇'].join('')
  }
  return [
    '<b>🤖👩🏻 <u>ГАЙД + чат: Как я заработал миллион на генерации ИИ-девушек для OnlyFans</u></b>\n\n',
    '🚀 И да, ты получаешь не просто гайд, а <b>ПОЖИЗНЕННЫЙ доступ</b> ко всем обновлениям и новым фишкам <i>(без каких либо доплат) </i>+ <b>общий ЧАТ </b><i>(где ты можешь задавать свои вопросы)</i> 🔥\n\n',
    `<blockquote><b>😱 <u>И вся эта инфа всего за ${priceText}₽</u> 😱</b></blockquote>\n\n`,
    '<i>P.S. цена такая низкая только на старте, так как мне нужны первые отзывы </i>🙌<i> Дальше стоимость вырастет в несколько раз, так что советую тебе поторопиться с покупкой </i>😉\n\n',
    'При проблемах с оплатой, писать сюда: @only_neuro_chat\n',
  ].join('')
}

// ================== SCENARIO HANDLERS ==================

bot.start(
  withErrorHandling(async (ctx) => {
    const from: any = ctx.from
    const { id, username, first_name, last_name } = from

    const message: any = ctx.message
    const text: string | undefined = message?.text
    const ref = text?.split(' ')[1] || 'noref'

    const telegramId = String(id)
    const existing = await prisma.user.findUnique({
      where: { telegramId },
      select: { id: true, refSource: true },
    })

    const user = existing
      ? await prisma.user.update({
          where: { telegramId },
          data: {
            username,
            firstName: first_name,
            lastName: last_name,
            refSource: ref,
            blockedByUser: false,
            blockedAt: null,
            blockReason: null,
            lastInteractionAt: new Date(),
            ...(existing.refSource ? {} : { refSource: ref }),
          },
        })
      : await prisma.user.create({
          data: {
            telegramId,
            paid: false,
            username,
            firstName: first_name,
            lastName: last_name,
            refSource: ref,
            blockedByUser: false,
            blockedAt: null,
            blockReason: null,
            lastInteractionAt: new Date(),
          },
        })

    const entryStepId = scenario.entryStepId
    await enterStepForUser(user.id, entryStepId, StepVisitSource.SYSTEM)
    await skipAllRemindersForUser(user.id)
    await scheduleRemindersForStep(user.id, entryStepId, 'default')
  }),
)

// обработчик всех callback'ов сценария
bot.action(
  /^SCN:/,
  withErrorHandling(async (ctx) => {
    await touchUserInteractionByTelegramId(String(ctx.from.id)).catch(() => {})
    const cb: any = ctx.callbackQuery

    if (!cb || typeof cb.data !== 'string') {
      return
    }

    const telegramId = String(ctx.from.id)

    const user = await prisma.user.findUnique({
      where: { telegramId },
    })

    if (!user) {
      await ctx.answerCbQuery().catch(() => {})
      await ctx.reply('👉 Для начала введите /start')
      return
    }

    const data = cb.data // "SCN:STEP:...", "SCN:SYSTEM:...", "SCN:OFFER:..."
    const parts = data.split(':')
    const type = parts[1] // STEP / SYSTEM / OFFER
    const payload = parts[2]

    switch (type) {
      case 'STEP': {
        await ctx.answerCbQuery().catch(() => {})

        const stepId = payload
        await enterStepForUser(user.id, stepId, StepVisitSource.CLICK)

        await skipAllRemindersForUser(user.id)
        await scheduleRemindersForStep(user.id, stepId, 'default')
        break
      }

      case 'SYSTEM': {
        const action = payload as SystemAction
        await ctx.answerCbQuery().catch(() => {})
        if (action === 'CHECK_SUBSCRIPTION') {
          const isOk = await hasJoinRequestsForAllRequiredChats(ctx.telegram, Number(user.telegramId), user.id)

          if (IS_PROD && !isOk) {
            await ctx.reply('К сожалению, ты все ещё не подписался 🙏')
            return
          }

          // считаем, что юзер "подписался" в рамках сценария
          if (!user.subscribed) {
            await prisma.user.update({
              where: { id: user.id },
              data: { subscribed: true },
            })
          }

          const nextStepId = '1763357438352'
          await enterStepForUser(user.id, nextStepId, StepVisitSource.SYSTEM)
          await scheduleRemindersForStep(user.id, nextStepId, 'default')
          return
        }

        if (action === 'SHOW_CONTENTS') {
          await ctx.reply(
            new FmtString(
              'Здесь будет отдельный шаг/материал с тем, <b>что именно внутри гайда</b>.\nПозже можно вынести в сценарий.',
            ),
            { parse_mode: 'HTML' },
          )
          return
        }

        if (action === 'SHOW_REVIEWS') {
          await ctx.reply('Отзывы учеников можно посмотреть здесь: @only_neuro_otzivi')
          return
        }

        if (action === 'EXIT') {
          await ctx.reply('Спасибо, что заглянул 🙌')
          return
        }

        break
      }

      case 'OFFER': {
        const offerKey = payload as OfferKey

        // Берём последний созданный инстанс оффера (любого статуса)
        let instance = await getLatestOfferInstance(user.id, offerKey)

        // Для старых пользователей (до обновления логики),
        // у которых инстанс ещё ни разу не создавался,
        // создаём его ОДИН РАЗ при первом клике.
        if (!instance) {
          instance = await ensureOfferInstanceStarted(user.id, offerKey)
        }

        const now = new Date()
        let expired = false

        if (instance.expiresAt) {
          const expiresDate = new Date(instance.expiresAt)
          if (expiresDate.getTime() <= now.getTime()) {
            expired = true

            if (instance.status === OfferStatus.ACTIVE) {
              instance = await prisma.offerInstance.update({
                where: { id: instance.id },
                data: {
                  status: OfferStatus.EXPIRED,
                  finishedAt: now,
                },
              })
            }
          }
        }

        // Кнопка "Получить" должна отрабатывать один раз:
        // после оплаты/отмены/истечения просто отвечаем в callback
        // и НЕ показываем новое окно.

        if (instance.status === OfferStatus.PAID) {
          await ctx.answerCbQuery('✅ Вы уже оплатили это предложение.', { show_alert: false }).catch(() => {})
          return
        }

        if (instance.status === OfferStatus.CANCELED) {
          await ctx.answerCbQuery('❌ Это предложение больше недоступно.', { show_alert: false }).catch(() => {})
          return
        }

        if (expired || instance.status === OfferStatus.EXPIRED) {
          await ctx.answerCbQuery('⏰ Срок действия предложения истёк.', { show_alert: false }).catch(() => {})
          return
        }

        // Здесь оффер ещё активен и не истёк — можно показать окно
        // и подготовить платёжную ссылку через WATA для РФ карты.
        await ctx.answerCbQuery().catch(() => {})

        let ruCardUrl: string | undefined
        try {
          ruCardUrl = await ensureWataPaymentLinkForOffer(instance)
        } catch (err) {
          console.error('WATA: ошибка при создании ссылки для оффера', err)
          // В этом случае будет использован RF_PAY_PLACEHOLDER_URL
        }

        const text = buildOfferWindowText(instance)
        const keyboard = buildOfferKeyboard(instance, ruCardUrl)

        const extra: any = { parse_mode: 'HTML', reply_markup: keyboard.reply_markup }

        const sent = await ctx.reply(new FmtString(text), extra)

        // ❗ Планируем удаление сообщения ТОЛЬКО для временных офферов
        if (instance.expiresAt) {
          await scheduleOfferMessageExpiration(instance, sent.chat.id, sent.message_id)
        }

        return
      }

      default:
        await ctx.answerCbQuery().catch(() => {})
        break
    }
  }),
)

bot.action(
  'HAPPY_END',
  withErrorHandling(async (ctx) => {
    await touchUserInteractionByTelegramId(String(ctx.from.id)).catch(() => {})
    const telegramId = String(ctx.from.id)

    const user = await prisma.user.findUnique({
      where: { telegramId },
      select: { id: true, agreed: true },
    })

    if (!user) {
      await ctx.answerCbQuery().catch(() => {})
      await ctx.reply('👉 Для начала введите /start')
      return
    }

    // Помечаем согласие с пользовательским соглашением
    if (!user.agreed) {
      await prisma.user.update({
        where: { id: user.id },
        data: { agreed: true },
      })
    }

    const { text, buttons } = actionsMessages.HAPPY_END

    await ctx.answerCbQuery().catch(() => {})

    await ctx.reply(new FmtString(text), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: inline_keyboard_generate(buttons),
      },
    })
  }),
)

// ================== ADMIN HANDLERS ==================

for (const [pattern, handler] of Object.entries(adminActions.callbacks)) {
  bot.action(pattern, withErrorHandling(handler))
}

bot.command('broadcast', adminActions.commands.broadcast)
bot.command('export', adminActions.commands.export)
bot.command('stop', adminActions.commands.stop)
bot.command('paid', adminActions.commands.paid)
bot.command('updateBlocked', adminActions.commands.updateBlocked)

// обработка обычных сообщений для админских штук
bot.on('message', async (ctx, next) => {
  if (ctx.from?.id) {
    await touchUserInteractionByTelegramId(String(ctx.from.id)).catch(() => {})
  }
  const msg: any = ctx.message

  if (msg && typeof msg.text === 'string') {
    return adminActions.messages.text(ctx as TextContext)
  }
  if (msg && msg.document) {
    return adminActions.messages.document(ctx as DocumentContext)
  }
  if (msg && msg.photo) {
    return adminActions.messages.photo(ctx as PhotoContext)
  }

  return next()
})

bot.on('chat_join_request', async (ctx) => {
  const { chat, from } = ctx.update.chat_join_request
  const chatId = String(chat.id)
  const telegramId = String(from.id)

  // на всякий случай – создать/обновить юзера, если его ещё нет
  const user = await prisma.user.findUnique({
    where: { telegramId },
  })

  if (!user) {
    return
  }

  // просто сохраняем факт, что у юзера есть заявка в этот чат
  await prisma.chatJoinRequest.upsert({
    where: {
      userId_chatId: {
        userId: user.id,
        chatId,
      },
    },
    create: {
      userId: user.id,
      chatId,
    },
    update: {},
  })
})

if (IS_PROD) {
  initBlockCheckScheduler().catch((e) => console.error('BlockCheck scheduler init error:', e))
}

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
