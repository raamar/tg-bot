import { toZonedTime, format } from 'date-fns-tz'

export const formatDate = (date: Date) => {
  const timeZone = 'Europe/Moscow'
  const zonedDate = toZonedTime(date, timeZone)

  return format(zonedDate, 'dd.MM.yyyy HH:mm:ss', { timeZone })
}
