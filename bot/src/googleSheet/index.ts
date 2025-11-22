// exportUsersToSheets.ts
import { type sheets_v4 } from '@googleapis/sheets'
import { prisma } from '../prisma'
import { createSheetsClient } from './sheetsAuth'
import { formatDate } from '../helpers/formatDate'
import { scenario } from '../scenario/config'
import { PaymentStatus } from '@prisma/client'

// Настройки листа/записи
const SHEET_NAME = 'Пользователи'
const BATCH_ROWS_DEFAULT = 5000
const MIN_BATCH = 1
const VALUE_INPUT_OPTION: 'RAW' | 'USER_ENTERED' = 'RAW'

// Шапка остаётся прежней (совпадает с Excel-выгрузкой)
const HEADERS = [
  'user_id',
  'username',
  'Имя',
  'Фамилия',
  'Дата регистрации',
  'Время регистрации',
  'ref',
  'ID Стадии',
  'Сумма',
  'Cсылка для оплаты',
  'Дата оплаты',
  'Время оплаты',
  'Согласие',
] as const

type RowTuple = [
  string, // user_id
  string, // username
  string, // Имя
  string, // Фамилия
  string, // Дата регистрации
  string, // Время регистрации
  string, // ref
  string, // ID Стадии (systemTitle или ID шага)
  string, // Сумма
  string, // Ссылка для оплаты
  string, // Дата оплаты
  string, // Время оплаты
  string // Согласие
]

// ---- ПОМОЩНИКИ ДЛЯ ПЛАТЕЖЕЙ ----

// Берём последний оплаченный платёж (по paidAt, потом createdAt)
const pickLastPaid = <T extends { status: PaymentStatus; paidAt: Date | null; createdAt: Date }>(ps: T[]) =>
  ps
    .filter((p) => p.status === 'PAID')
    .sort(
      (a, b) => (b.paidAt?.getTime() ?? 0) - (a.paidAt?.getTime() ?? 0) || b.createdAt.getTime() - a.createdAt.getTime()
    )[0]

// Берём самый актуальный инвойс для оплаты — последний PENDING по createdAt
const pickLatestPending = <T extends { status: PaymentStatus; createdAt: Date }>(ps: T[]) =>
  ps.filter((p) => p.status === 'PENDING').sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]

// ---- ТРАНСФОРМ В СТРОКИ ----

type ExportUser = Awaited<ReturnType<typeof getUsers>>[number]

const usersToRows = (users: ExportUser[]): RowTuple[] =>
  users.map((u) => {
    const paid = pickLastPaid(u.payments)
    const pending = pickLatestPending(u.payments)

    const createdParts = formatDate(u.createdAt).split(' ')
    const paidParts = paid?.paidAt ? formatDate(paid.paidAt).split(' ') : ['', '']

    const currentStepId = u.currentStepId || ''
    const systemTitle = scenario.steps[currentStepId]?.systemTitle
    const stageCell = systemTitle || String(currentStepId || '')

    return [
      String(u.telegramId ?? ''),
      u.username ?? '',
      u.firstName ?? '',
      u.lastName ?? '',
      createdParts[0] ?? '',
      createdParts[1] ?? '',
      u.refSource ?? '',
      stageCell, // как в Excel: systemTitle или ID шага
      paid?.amount != null ? String(paid.amount) : '', // сумма последнего успешного платежа
      pending?.url ?? '', // ссылка на актуальный инвойс (если есть)
      paidParts[0],
      paidParts[1],
      u.agreed ? 'Да' : 'Нет',
    ]
  })

// ---- РЕТРАЙ С БЭКОФФОМ ----

const getStatusCode = (e: unknown): number | undefined => {
  if (typeof e !== 'object' || e === null) return undefined
  const obj = e as Record<string, unknown>
  const code = typeof obj.code === 'number' ? obj.code : undefined
  const resp = obj.response as Record<string, unknown> | undefined
  const status = typeof resp?.status === 'number' ? (resp.status as number) : undefined
  return code ?? status
}

const backoff = async <T>(fn: () => Promise<T>, attempt = 0): Promise<T> => {
  try {
    return await fn()
  } catch (e) {
    const status = getStatusCode(e)
    if (status && [413, 429, 500, 502, 503, 504].includes(status) && attempt < 6) {
      const base = Math.min(64, 2 ** attempt)
      const jitter = Math.floor(Math.random() * 1000)
      await new Promise((r) => setTimeout(r, base * 1000 + jitter))
      return backoff(fn, attempt + 1)
    }
    throw e
  }
}

// ---- ЗАПИСЬ В GOOGLE SHEETS ----

export const replaceSheetWithUsers = async (
  client: sheets_v4.Sheets,
  spreadsheetId: string,
  users: ExportUser[]
): Promise<void> => {
  const rows = usersToRows(users)
  if (rows.length === 0) {
    await backoff(() =>
      client.spreadsheets.values.update({
        spreadsheetId,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: VALUE_INPUT_OPTION,
        requestBody: { values: [HEADERS as unknown as string[]] },
      })
    )
    return
  }

  let batchSize = BATCH_ROWS_DEFAULT
  let i = 0
  let startRow = 1

  while (i < rows.length) {
    const isFirst = i === 0
    const capacity = isFirst ? Math.max(MIN_BATCH, batchSize - 1) : batchSize
    const end = Math.min(i + capacity, rows.length)
    const slice = rows.slice(i, end)
    const values = isFirst ? ([HEADERS as unknown as string[], ...slice] as string[][]) : (slice as string[][])
    const range = `${SHEET_NAME}!A${startRow}`

    const writeChunk = async (): Promise<void> => {
      await client.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: VALUE_INPUT_OPTION,
        requestBody: { values },
      })
    }

    try {
      await backoff(writeChunk)
      i = end
      startRow += values.length
    } catch (e) {
      const status = getStatusCode(e)
      if ((status === 400 || status === 413) && batchSize > MIN_BATCH) {
        batchSize = Math.max(MIN_BATCH, Math.floor(batchSize / 2))
        continue
      }
      if (isFirst && values.length > 1) {
        await backoff(() =>
          client.spreadsheets.values.update({
            spreadsheetId,
            range: `${SHEET_NAME}!A1`,
            valueInputOption: VALUE_INPUT_OPTION,
            requestBody: { values: [HEADERS as unknown as string[]] },
          })
        )
        startRow = 2
        continue
      }
      throw e
    }
  }
}

// ---- ДАННЫЕ И ЗАПУСК ----

// Под новую схему нам нужны только payments; currentStepId берём из User
const getUsers = async () =>
  prisma.user.findMany({
    include: {
      payments: true, // Payment[]
    },
    orderBy: { createdAt: 'asc' },
  })

const parseMinutes = (v: string | undefined, d: number): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : d
}

const runOnce = async (): Promise<void> => {
  const sheets = await createSheetsClient()
  const spreadsheetId = process.env.GOOGLE_SHEET_ID || ''
  if (!spreadsheetId) throw new Error('GOOGLE_SHEET_ID is required')

  const users = await getUsers()
  await replaceSheetWithUsers(sheets, spreadsheetId, users)
}

const start = async (): Promise<void> => {
  await runOnce()
  const minutes = parseMinutes(process.env.GOOGLE_SHEET_INTERVAL, 5)
  const intervalMs = minutes * 60_000
  setInterval(async () => {
    try {
      await runOnce()
    } catch (e) {
      console.error(e)
    }
  }, intervalMs)
}

start().catch((e) => {
  console.error(e)
})
