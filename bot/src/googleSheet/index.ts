// exportUsersToSheets.ts
import { type sheets_v4 } from '@googleapis/sheets'
import { prisma } from '../prisma'
import { createSheetsClient } from './sheetsAuth'
import { formatDate } from '../helpers/formatDate'
import { scenario } from '../scenario/config'
import { PaymentStatus } from '@prisma/client'

// =====================
// НАСТРОЙКИ
// =====================

const SHEET_NAME = process.env.GOOGLE_SHEET_LIST_NAME || 'Пользователи'

// Пишем пачками, чтобы не упираться в payload/timeout. При 413/400 — уменьшаем.
const BATCH_ROWS_DEFAULT = 5000
const MIN_BATCH = 1
const VALUE_INPUT_OPTION: 'RAW' | 'USER_ENTERED' = 'RAW'

// Лимит Google Sheets: максимум 10,000,000 ячеек на один spreadsheet (суммарно по всем листам).
// Это ограничение платформы, кодом его “убрать” нельзя — можно только не превышать.
// Здесь мы защищаемся и выдаём понятную ошибку.
const MAX_CELLS_PER_SPREADSHEET = 10_000_000

// Если лист — чисто под выгрузку, имеет смысл “подгонять” grid ровно под данные,
// чтобы не раздуть количество ячеек и не упереться в 10M. Если у вас на листе
// есть “ручные” колонки/формулы правее — поставьте false.
const SHRINK_GRID_TO_FIT = true

// =====================
// ШАПКА (как в Excel-выгрузке)
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
  string // Согласие
]

// =====================
// ПОМОЩНИКИ ДЛЯ ПЛАТЕЖЕЙ
// =====================

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

// =====================
// ТРАНСФОРМ В СТРОКИ
// =====================

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
      stageCell,
      paid?.amount != null ? String(paid.amount) : '',
      pending?.url ?? '',
      paidParts[0],
      paidParts[1],
      u.agreed ? 'Да' : 'Нет',
    ]
  })

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
  const meta = await client.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))',
  })

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

  // Создаём лист, если его нет
  await client.spreadsheets.batchUpdate({
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
  })

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

  // Подгоняем grid под данные (или только увеличиваем — зависит от SHRINK_GRID_TO_FIT)
  const targetRowCount = SHRINK_GRID_TO_FIT ? Math.max(1, rowsNeeded) : Math.max(currentRowCount, rowsNeeded)
  const targetColCount = SHRINK_GRID_TO_FIT ? Math.max(1, colsNeeded) : Math.max(currentColCount, colsNeeded)

  // Считаем текущий “размер” spreadsheet в ячейках (сумма rowCount*columnCount по листам)
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

  await client.spreadsheets.batchUpdate({
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
  })

  // Возвращаем обновлённые props (не обязательно, но удобно)
  return { ...sheet, rowCount: targetRowCount, columnCount: targetColCount }
}

// =====================
// ЗАПИСЬ В GOOGLE SHEETS
// =====================

export const replaceSheetWithUsers = async (
  client: sheets_v4.Sheets,
  spreadsheetId: string,
  users: ExportUser[]
): Promise<void> => {
  const rows = usersToRows(users)

  // Нужно строк: header + rows
  const rowsNeeded = rows.length + 1
  const colsNeeded = HEADERS.length

  // 1) УБИРАЕМ “ЛИМИТ 5000 СТРОК”:
  // гарантируем, что у листа достаточно rowCount/columnCount,
  // иначе второй чанк в A5001 упрётся в “exceeds grid limits”.
  await backoff(() => ensureSheetGrid(client, spreadsheetId, SHEET_NAME, rowsNeeded, colsNeeded))

  // 2) Чистим диапазон, чтобы при уменьшении количества строк не оставался “хвост”
  const lastCol = colToA1(colsNeeded)
  await backoff(() =>
    client.spreadsheets.values.clear({
      spreadsheetId,
      range: `${qSheet(SHEET_NAME)}!A:${lastCol}`,
    })
  )

  // 3) Пишем данные
  if (rows.length === 0) {
    await backoff(() =>
      client.spreadsheets.values.update({
        spreadsheetId,
        range: `${qSheet(SHEET_NAME)}!A1`,
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

    const range = `${qSheet(SHEET_NAME)}!A${startRow}`

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

      // Если это payload/invalid-range ошибки — уменьшаем batch
      if ((status === 400 || status === 413) && batchSize > MIN_BATCH) {
        batchSize = Math.max(MIN_BATCH, Math.floor(batchSize / 2))
        continue
      }

      // Если вдруг упали на первой пачке — хотя бы шапку запишем
      if (isFirst && values.length > 1) {
        await backoff(() =>
          client.spreadsheets.values.update({
            spreadsheetId,
            range: `${qSheet(SHEET_NAME)}!A1`,
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

// =====================
// ДАННЫЕ И ЗАПУСК
// =====================

const getUsers = async () =>
  prisma.user.findMany({
    include: { payments: true },
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

const IS_PROD = process.env.NODE_ENV === 'production'

if (IS_PROD) {
  start().catch((e) => {
    console.error(e)
  })
}
