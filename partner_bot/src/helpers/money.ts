import { Prisma } from '@app/db'

export const BASE_EARNING_RATE = new Prisma.Decimal('0.623')

const formatIntegerWithSpaces = (value: number): string => {
  const floored = Math.round(value)
  const formatted = floored.toLocaleString('ru-RU', {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  })
  return formatted.replace(/[\u00A0\u202F]/g, ' ')
}

export const formatMoneyUi = (value: Prisma.Decimal | number): string => {
  const num = typeof value === 'number' ? value : value.toNumber()
  return formatIntegerWithSpaces(num)
}

export const parseAmount = (text: string): number | null => {
  const normalized = text.replace(',', '.').replace(/\s+/g, '')
  const value = Number.parseFloat(normalized)
  if (!Number.isFinite(value) || value <= 0) return null
  return value
}

export const formatMoneyCsv = (value: Prisma.Decimal | number): string => {
  const num = typeof value === 'number' ? value : value.toNumber()
  return num.toFixed(2)
}

export const formatCountUi = (value: Prisma.Decimal | number): string => {
  const num = typeof value === 'number' ? value : value.toNumber()
  return formatIntegerWithSpaces(num)
}

export const parsePercent = (text: string): number | null => {
  const normalized = text.replace('%', '').replace(',', '.').replace(/\s+/g, '')
  const value = Number.parseFloat(normalized)
  if (!Number.isFinite(value) || value <= 0 || value > 100) return null
  return value
}

export const formatPercentUi = (value: Prisma.Decimal | number): string => {
  const num = typeof value === 'number' ? value : value.toNumber()
  const percent = num * 100
  return formatIntegerWithSpaces(percent)
}
