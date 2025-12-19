// bot/src/googleSheet/index.ts

import { type sheets_v4 } from '@googleapis/sheets'
import { prisma } from '../prisma'
import { createSheetsClient } from './sheetsAuth'
import { formatDate } from '../helpers/formatDate'
import { scenario } from '../scenario/config'
import { PaymentStatus, type Prisma } from '@prisma/client'

// =====================
// НАСТРОЙКИ
// =====================

const SHEET_NAME = process.env.GOOGLE_SHEET_LIST_NAME || 'Пользователи'

// Пишем пачками. 1000–2000 обычно стабильнее, чем 5000 (особенно с длинными URL).
const BATCH_ROWS_DEFAULT = 2000
const MIN_BATCH = 1

const VALUE_INPUT_OPTION: 'RAW' | 'USER_ENTERED' = 'RAW'

// Таймаут на один запрос к Google API (иначе может "висеть" очень долго/бесконечно)
const REQUEST_TIMEOUT_MS = Number(process.env.GOOGLE_SHEET_TIMEOUT_MS ?? '120000') // 120s

// Лимит Google Sheets: максимум 10,000,000 ячеек на один spreadsheet (суммарно по всем листам).
const MAX_CELLS_PER_SPREADSHEET = 10_000_000

const SHRINK_GRID_TO_FIT = true

// =====================
// ШАПКА (как в CSV/Excel-выгрузке)
// =====================

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
  // ✅ blocked fields
  'blockedByUser',
  'blockedDate',
  'blockedTime',
  'lastInteractionDate',
  'lastInteractionTime',
  'blockReason',
] as const

type RowTuple = [
  string, // user_id
  string, // username
  string, // Имя
  string, // Фамилия
  string, // Дата регистрации
  string, // Время регистрации
  string, // ref
  string, // ID Стадии
  string, // Сумма
  string, // Ссылка для оплаты
  string, // Дата оплаты
  string, // Время оплаты
  string, // Согласие
  // blocked fields
  string, // blockedByUser (Да/Нет)
  string, // blockedDate
  string, // blockedTime
  string, // lastInteractionDate
  string, // lastInteractionTime
  string // blockReason
]

// =====================
// RETRY + BACKOFF
// =====================

const getStatusCode = (e: unknown): number | undefined => {
  if (typeof e !== 'object' || e === null) return undefined
  const obj = e as Record<string, unknown>
  const code = typeof obj.code === 'number' ? obj.code : undefined
  const resp = obj.response as Record<string, unknown> | undefined
  const status = typeof resp?.status === 'number' ? (resp.status as number) : undefined
  return code ?? status
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const backoff = async <T>(fn: () => Promise<T>, attempt = 0): Promise<T> => {
  try {
    return await fn()
  } catch (e) {
    const status = getStatusCode(e)
    if (status && [408, 413, 429, 500, 502, 503, 504].includes(status) && attempt < 6) {
      const base = Math.min(64, 2 ** attempt)
      const jitter = Math.floor(Math.random() * 1000)
      await sleep(base * 1000 + jitter)
      return backoff(fn, attempt + 1)
    }
    throw e
  }
}

// =====================
// A1-УТИЛИТЫ
// =====================

const qSheet = (title: string) => `'${title.replace(/'/g, "''")}'`

const colToA1 = (colIndex1: number): string => {
  // 1 -> A, 26 -> Z, 27 -> AA ...
  let n = colIndex1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

// =====================
// SHEET META / GRID ENSURE
// =====================

type SheetProps = {
  sheetId: number
  title: string
  rowCount: number
  columnCount: number
}

const fetchSheetProps = async (client: sheets_v4.Sheets, spreadsheetId: string): Promise<{ sheets: SheetProps[] }> => {
  const meta = await client.spreadsheets.get(
    {
      spreadsheetId,
      fields: 'sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))',
    },
    { timeout: REQUEST_TIMEOUT_MS }
  )

  const sheets =
    meta.data.sheets?.flatMap((s) => {
      const p = s.properties
      if (!p?.sheetId || !p.title) return []
      return [
        {
          sheetId: p.sheetId,
          title: p.title,
          rowCount: p.gridProperties?.rowCount ?? 0,
          columnCount: p.gridProperties?.columnCount ?? 0,
        },
      ]
    }) ?? []

  return { sheets }
}

const ensureSheetExists = async (
  client: sheets_v4.Sheets,
  spreadsheetId: string,
  title: string
): Promise<SheetProps> => {
  const meta1 = await fetchSheetProps(client, spreadsheetId)
  const found1 = meta1.sheets.find((s) => s.title === title)
  if (found1) return found1

  await client.spreadsheets.batchUpdate(
    {
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title,
                gridProperties: {
                  rowCount: 2,
                  columnCount: HEADERS.length,
                },
              },
            },
          },
        ],
      },
    },
    { timeout: REQUEST_TIMEOUT_MS }
  )

  const meta2 = await fetchSheetProps(client, spreadsheetId)
  const found2 = meta2.sheets.find((s) => s.title === title)
  if (!found2) throw new Error(`Failed to create sheet "${title}"`)
  return found2
}

const ensureSheetGrid = async (
  client: sheets_v4.Sheets,
  spreadsheetId: string,
  title: string,
  rowsNeeded: number,
  colsNeeded: number
): Promise<SheetProps> => {
  const meta = await fetchSheetProps(client, spreadsheetId)
  const sheet = meta.sheets.find((s) => s.title === title) ?? (await ensureSheetExists(client, spreadsheetId, title))

  const currentRowCount = sheet.rowCount
  const currentColCount = sheet.columnCount

  const targetRowCount = SHRINK_GRID_TO_FIT ? Math.max(1, rowsNeeded) : Math.max(currentRowCount, rowsNeeded)
  const targetColCount = SHRINK_GRID_TO_FIT ? Math.max(1, colsNeeded) : Math.max(currentColCount, colsNeeded)

  const currentTotalCells = meta.sheets.reduce((acc, s) => acc + s.rowCount * s.columnCount, 0)
  const currentSheetCells = currentRowCount * currentColCount
  const targetSheetCells = targetRowCount * targetColCount
  const targetTotalCells = currentTotalCells - currentSheetCells + targetSheetCells

  if (targetTotalCells > MAX_CELLS_PER_SPREADSHEET) {
    throw new Error(
      [
        `Google Sheets limit exceeded: spreadsheet would have ${targetTotalCells.toLocaleString()} cells.`,
        `Max allowed is ${MAX_CELLS_PER_SPREADSHEET.toLocaleString()} cells per spreadsheet.`,
        `Data rows needed: ${rowsNeeded.toLocaleString()}, columns: ${colsNeeded.toLocaleString()}.`,
        `Fix: reduce columns/rows, split into multiple spreadsheets, or store data outside Sheets (BigQuery/DB/CSV).`,
      ].join(' ')
    )
  }

  const needsUpdate = currentRowCount !== targetRowCount || currentColCount !== targetColCount
  if (!needsUpdate) return sheet

  await client.spreadsheets.batchUpdate(
    {
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: sheet.sheetId,
                gridProperties: {
                  rowCount: targetRowCount,
                  columnCount: targetColCount,
                },
              },
              fields: 'gridProperties(rowCount,columnCount)',
            },
          },
        ],
      },
    },
    { timeout: REQUEST_TIMEOUT_MS }
  )

  return { ...sheet, rowCount: targetRowCount, columnCount: targetColCount }
}

// =====================
// ДАННЫЕ И ПОДГОТОВКА РЯДОВ (БЕЗ СОРТИРОВОК В JS)
// =====================

type UserRow = Prisma.UserGetPayload<{
  select: {
    id: true
    telegramId: true
    username: true
    firstName: true
    lastName: true
    createdAt: true
    refSource: true
    currentStepId: true
    agreed: true
    blockedByUser: true
    blockedAt: true
    lastInteractionAt: true
    blockReason: true
  }
}>

type PaidPaymentRow = Prisma.PaymentGetPayload<{
  select: { userId: true; amount: true; paidAt: true; createdAt: true }
}>

type PendingPaymentRow = Prisma.PaymentGetPayload<{
  select: { userId: true; url: true; createdAt: true }
}>

const usersBatchToRows = (
  users: UserRow[],
  lastPaidByUserId: Map<UserRow['id'], { amount: unknown; paidAt: Date | null }>,
  lastPendingByUserId: Map<UserRow['id'], { url: string | null }>
): RowTuple[] => {
  return users.map((u) => {
    const paid = lastPaidByUserId.get(u.id)
    const pending = lastPendingByUserId.get(u.id)

    const createdParts = formatDate(u.createdAt).split(' ')
    const paidParts = paid?.paidAt ? formatDate(paid.paidAt).split(' ') : ['', '']

    const currentStepId = u.currentStepId || ''
    const systemTitle = scenario.steps[currentStepId]?.systemTitle
    const stageCell = systemTitle || String(currentStepId || '')

    const blockedParts = u.blockedAt ? formatDate(u.blockedAt).split(' ') : ['', '']
    const lastIntParts = u.lastInteractionAt ? formatDate(u.lastInteractionAt).split(' ') : ['', '']

    return [
      String(u.telegramId ?? ''),
      u.username ?? '',
      u.firstName ?? '',
      u.lastName ?? '',
      createdParts[0] ?? '',
      createdParts[1] ?? '',
      u.refSource ?? '',
      stageCell,
      paid?.amount != null ? String(paid.amount) : '',
      pending?.url ?? '',
      paidParts[0],
      paidParts[1],
      u.agreed ? 'Да' : 'Нет',
      // blocked fields
      u.blockedByUser ? 'Да' : 'Нет',
      blockedParts[0] ?? '',
      blockedParts[1] ?? '',
      lastIntParts[0] ?? '',
      lastIntParts[1] ?? '',
      u.blockReason ?? '',
    ]
  })
}

// =====================
// ЗАПИСЬ В GOOGLE SHEETS (СТРИМИНГ БАТЧАМИ ИЗ БД)
// =====================

export const replaceSheetWithUsers = async (client: sheets_v4.Sheets, spreadsheetId: string): Promise<void> => {
  const colsNeeded = HEADERS.length
  const totalUsers = await prisma.user.count()
  const rowsNeeded = totalUsers + 1 // header + data

  // 1) гарантируем размер grid
  await backoff(() => ensureSheetGrid(client, spreadsheetId, SHEET_NAME, rowsNeeded, colsNeeded))

  // 2) чистим диапазон под фактический объём (не весь столбец A:M)
  const lastCol = colToA1(colsNeeded)
  const clearRange = `${qSheet(SHEET_NAME)}!A1:${lastCol}${rowsNeeded}`
  await backoff(() =>
    client.spreadsheets.values.clear(
      {
        spreadsheetId,
        range: clearRange,
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  )

  // 3) пишем шапку
  await backoff(() =>
    client.spreadsheets.values.update(
      {
        spreadsheetId,
        range: `${qSheet(SHEET_NAME)}!A1`,
        valueInputOption: VALUE_INPUT_OPTION,
        requestBody: { values: [HEADERS as unknown as string[]] },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  )

  // 4) пишем данные батчами из БД
  let batchSize = BATCH_ROWS_DEFAULT
  let cursorId: UserRow['id'] | null = null
  let startRow = 2

  while (true) {
    const users: UserRow[] = await prisma.user.findMany({
      select: {
        id: true,
        telegramId: true,
        username: true,
        firstName: true,
        lastName: true,
        createdAt: true,
        refSource: true,
        currentStepId: true,
        agreed: true,
        blockedByUser: true,
        blockedAt: true,
        lastInteractionAt: true,
        blockReason: true,
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    })

    if (users.length === 0) break

    const userIds: UserRow['id'][] = users.map((u) => u.id)

    const paidPayments: PaidPaymentRow[] = await prisma.payment.findMany({
      where: { userId: { in: userIds }, status: PaymentStatus.PAID },
      select: { userId: true, amount: true, paidAt: true, createdAt: true },
      orderBy: [{ userId: 'asc' }, { paidAt: 'desc' }, { createdAt: 'desc' }],
    })

    const lastPaidByUserId = new Map<UserRow['id'], { amount: unknown; paidAt: Date | null }>()
    for (const p of paidPayments) {
      if (!lastPaidByUserId.has(p.userId)) {
        lastPaidByUserId.set(p.userId, { amount: p.amount, paidAt: p.paidAt })
      }
    }

    const pendingPayments: PendingPaymentRow[] = await prisma.payment.findMany({
      where: { userId: { in: userIds }, status: PaymentStatus.PENDING },
      select: { userId: true, url: true, createdAt: true },
      orderBy: [{ userId: 'asc' }, { createdAt: 'desc' }],
    })

    const lastPendingByUserId = new Map<UserRow['id'], { url: string | null }>()
    for (const p of pendingPayments) {
      if (!lastPendingByUserId.has(p.userId)) {
        lastPendingByUserId.set(p.userId, { url: p.url })
      }
    }

    const rows: RowTuple[] = usersBatchToRows(users, lastPaidByUserId, lastPendingByUserId)

    const range = `${qSheet(SHEET_NAME)}!A${startRow}`

    const writeChunk = async (): Promise<void> => {
      await client.spreadsheets.values.update(
        {
          spreadsheetId,
          range,
          valueInputOption: VALUE_INPUT_OPTION,
          requestBody: { values: rows as unknown as string[][] },
        },
        { timeout: REQUEST_TIMEOUT_MS }
      )
    }

    try {
      await backoff(writeChunk)
      startRow += rows.length
      cursorId = users[users.length - 1].id
    } catch (e) {
      const status = getStatusCode(e)

      if ((status === 400 || status === 413) && batchSize > MIN_BATCH) {
        batchSize = Math.max(MIN_BATCH, Math.floor(batchSize / 2))
        continue
      }

      throw e
    }
  }
}

// =====================
// ЗАПУСК + LOCK (чтобы setInterval не запускал параллельные прогоны)
// =====================

const parseMinutes = (v: string | undefined, d: number): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : d
}

let isRunning = false

const runOnce = async (): Promise<void> => {
  if (isRunning) {
    console.warn('[googleSheet] Skip: previous sync is still running')
    return
  }
  isRunning = true

  try {
    const sheets = await createSheetsClient()
    const spreadsheetId = process.env.GOOGLE_SHEET_ID || ''
    if (!spreadsheetId) throw new Error('GOOGLE_SHEET_ID is required')

    await replaceSheetWithUsers(sheets, spreadsheetId)
    console.log('[googleSheet] Sync completed')
  } finally {
    isRunning = false
  }
}

const start = async (): Promise<void> => {
  await runOnce()
  const minutes = parseMinutes(process.env.GOOGLE_SHEET_INTERVAL, 5)
  const intervalMs = minutes * 60_000

  setInterval(async () => {
    try {
      await runOnce()
    } catch (e) {
      console.error('[googleSheet] Sync failed:', e)
    }
  }, intervalMs)
}

const IS_PROD = process.env.NODE_ENV === 'production'

if (IS_PROD) {
  start().catch((e) => {
    console.error(e)
  })
}
