import { type sheets_v4 } from '@googleapis/sheets'

import { prisma } from '../prisma'
import { ExportUser } from '../helpers/exportToExcel'
import { createSheetsClient } from './sheetsAuth'
import { formatDate } from '../helpers/formatDate'

const SHEET_NAME = 'Пользователи'
const BATCH_ROWS_DEFAULT = 5000
const MIN_BATCH = 1
const VALUE_INPUT_OPTION: 'RAW' | 'USER_ENTERED' = 'RAW'

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
] as const

type RowTuple = [string, string, string, string, string, string, string, string, string, string, string, string]

const usersToRows = (users: ExportUser[]): RowTuple[] =>
  users.map((u) => {
    const paid = u.payments.find((p) => p.status === 'PAID')
    const created = formatDate(u.createdAt).split(' ')
    const paidParts = paid?.paidAt ? formatDate(paid.paidAt).split(' ') : ['', '']
    return [
      String(u.telegramId ?? ''),
      u.username ?? '',
      u.firstName ?? '',
      u.lastName ?? '',
      created[0] ?? '',
      created[1] ?? '',
      u.refSource ?? '',
      String(u.funnelProgress?.stageId ?? ''),
      paid?.amount != null ? String(paid.amount) : '',
      paid?.url ?? '',
      paidParts[0],
      paidParts[1],
    ]
  })

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

const getUsers = async (): Promise<ExportUser[]> =>
  prisma.user.findMany({
    include: {
      funnelProgress: true,
      payments: true,
    },
    orderBy: {
      createdAt: 'asc',
    },
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
