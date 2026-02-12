import ExcelJS from 'exceljs'
import { User, PaymentStatus } from '@app/db'
import { formatDate } from './formatDate'
import { scenario } from '../scenario/config'

export type ExportUser = User & {
  payments: {
    status: PaymentStatus
    amount: any
    url: string | null
    paidAt: Date | null
    createdAt: Date
  }[]
}

/** Берём последний оплаченный платёж: по paidAt, потом createdAt */
const pickLastPaid = <T extends { status: PaymentStatus; paidAt: Date | null; createdAt: Date }>(ps: T[]) =>
  ps
    .filter((p) => p.status === 'PAID')
    .sort(
      (a, b) =>
        (b.paidAt?.getTime() ?? 0) - (a.paidAt?.getTime() ?? 0) || b.createdAt.getTime() - a.createdAt.getTime(),
    )[0]

/** Самый актуальный инвойс: последний PENDING по createdAt */
const pickLatestPending = <T extends { status: PaymentStatus; createdAt: Date }>(ps: T[]) =>
  ps.filter((p) => p.status === 'PENDING').sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]

export const generateUserExcelBuffer = async (users: ExportUser[]): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Пользователи')

  sheet.columns = [
    { header: 'user_id', key: 'userId', width: 20 },
    { header: 'username', key: 'username', width: 20 },
    { header: 'Имя', key: 'firstName', width: 20 },
    { header: 'Фамилия', key: 'lastName', width: 20 },
    { header: 'Дата регистрации', key: 'createdDate', width: 15 },
    { header: 'Время регистрации', key: 'createdTime', width: 15 },
    { header: 'ref', key: 'refSource', width: 20 },
    { header: 'ID Стадии', key: 'stageId', width: 20 },
    { header: 'Сумма', key: 'amount', width: 12 },
    { header: 'Cсылка для оплаты', key: 'url', width: 40 },
    { header: 'Дата оплаты', key: 'paidDate', width: 15 },
    { header: 'Время оплаты', key: 'paidTime', width: 15 },
    { header: 'Согласие', key: 'agreed', width: 12 },
  ]

  for (const user of users) {
    const createdParts = formatDate(user.createdAt).split(' ')
    const paidPayment = pickLastPaid(user.payments)
    const pendingPayment = pickLatestPending(user.payments)

    const paidDate = paidPayment?.paidAt ? formatDate(paidPayment.paidAt).split(' ')[0] : ''
    const paidTime = paidPayment?.paidAt ? formatDate(paidPayment.paidAt).split(' ')[1] : ''

    sheet.addRow({
      userId: user.telegramId,
      username: user.username || '',
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      createdDate: createdParts[0] ?? '',
      createdTime: createdParts[1] ?? '',
      refSource: user.refSource || '',
      stageId: scenario.steps[user.currentStepId || '']?.systemTitle || user.currentStepId, // ← раньше было funnelProgress.stageId
      amount: paidPayment?.amount != null ? String(paidPayment.amount) : '',
      url: pendingPayment?.url || '', // ← свежая ссылка на оплату
      paidDate,
      paidTime,
      agreed: user.agreed ? 'Да' : 'Нет',
    })
  }

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}
