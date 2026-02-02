import { Prisma } from '@app/db'

export const BASE_EARNING_RATE = new Prisma.Decimal('0.623')

export const formatMoney = (value: Prisma.Decimal | number): string => {
  const num = typeof value === 'number' ? value : value.toNumber()
  const floored = Math.floor(num)
  const formatted = floored.toLocaleString('ru-RU', {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  })
  return formatted.replace(/[\u00A0\u202F]/g, ' ')
}

export const parseAmount = (text: string): number | null => {
  const normalized = text.replace(',', '.').replace(/\s+/g, '')
  const value = Number.parseFloat(normalized)
  if (!Number.isFinite(value) || value <= 0) return null
  return value
}

export const parsePercent = (text: string): number | null => {
  const normalized = text.replace('%', '').replace(',', '.').replace(/\s+/g, '')
  const value = Number.parseFloat(normalized)
  if (!Number.isFinite(value) || value <= 0 || value > 100) return null
  return value
}

export const formatPercent = (value: Prisma.Decimal | number): string => {
  const num = typeof value === 'number' ? value : value.toNumber()
  const percent = num * 100
  const fixed = percent.toFixed(2)
  return fixed.replace(/\.?0+$/, '')
}
