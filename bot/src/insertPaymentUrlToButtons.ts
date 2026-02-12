// import { getCloudPaymentsUrl } from './helpers/getCloudPaymentsUrl'
// import { prisma } from './prisma'
// import { InlineButton } from './types/funnel'

// export const insertPaymentUrlToButtons = async (buttons: InlineButton[], userId: string) => {
//   const amounts = buttons.filter((button) => button.action === 'BUY_LINK').map((button) => button.amount)

//   const orders = await Promise.all(
//     amounts.map((amount) =>
//       prisma.payment.create({
//         data: {
//           userId,
//           amount,
//           status: 'NONE',
//         },
//       })
//     )
//   )

//   const ordersWithUrl = await Promise.all(
//     orders.map(async (order) => {
//       const url = await getCloudPaymentsUrl(order.id, userId, Number(order.amount.toFixed(2)))
//       return { ...order, url }
//     })
//   )

//   await Promise.all(
//     ordersWithUrl.map((order) =>
//       prisma.payment.update({
//         where: { id: order.id },
//         data: {
//           status: 'PENDING',
//           url: order.url,
//         },
//       })
//     )
//   )

//   let i = 0
//   buttons.forEach((button) => {
//     if (button.action !== 'BUY_LINK') {
//       return
//     }

//     const order = ordersWithUrl[i]
//     button.url = order.url

//     i += 1
//   })
// }
