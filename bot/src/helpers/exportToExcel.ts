import ExcelJS from 'exceljs'
import { User, PaymentStatus } from '@prisma/client'
import { formatDate } from './formatDate'

type ExportUser = User & {
  funnelProgress?: {
    stageId: string
  } | null
  payments: {
    status: PaymentStatus
    amount: any
    url: string | null
    paidAt: Date | null
  }[]
}

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
    { header: 'ID Стадии', key: 'stageId', width: 15 },
    { header: 'Сумма', key: 'amount', width: 10 },
    { header: 'Cсылка для оплаты', key: 'url', width: 30 },
    { header: 'Дата оплаты', key: 'paidDate', width: 15 },
    { header: 'Время оплаты', key: 'paidTime', width: 15 },
  ]

  for (const user of users) {
    const paidPayment = user.payments.find((p) => p.status === 'PAID')

    sheet.addRow({
      userId: user.telegramId,
      username: user.username || '',
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      createdDate: formatDate(user.createdAt).split(' ')[0],
      createdTime: formatDate(user.createdAt).split(' ')[1],
      refSource: user.refSource || '',
      stageId: user.funnelProgress?.stageId || '',
      amount: paidPayment?.amount?.toString() || '',
      url: paidPayment?.url || '',
      paidDate: paidPayment?.paidAt ? formatDate(paidPayment.paidAt).split(' ')[0] : '',
      paidTime: paidPayment?.paidAt ? formatDate(paidPayment.paidAt).split(' ')[1] : '',
    })
  }

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}
