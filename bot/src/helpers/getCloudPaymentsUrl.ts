import axios from 'axios'

export const getCloudPaymentsUrl = async (orderId: string, userId: string, amount: number) => {
  const payload = {
    Amount: amount,
    Currency: 'RUB',
    Description: 'Гайд: Миллион на ИИ аватаре',
    InvoiceId: orderId,
    AccountId: userId,
    JsonData: {
      cloudpayments: {
        inn: process.env.SHOP_INN,
        type: 0,
        customerReceipt: {
          items: [
            {
              label: 'Гайд: Миллион на ИИ аватаре',
              price: amount,
              quantity: 1,
              amount: amount,
              vat: 0,
            },
          ],
          taxationSystem: 0,
          amounts: {
            electronic: amount,
          },
        },
      },
    },
  }

  const auth = {
    username: process.env.CLOUDPAYMENTS_PUBLIC_ID!,
    password: process.env.CLOUDPAYMENTS_API_SECRET!,
  }
  const response = await axios
    .post('https://api.cloudpayments.ru/orders/create', payload, { auth, timeout: 2000 })
    .catch(() => {
      throw new Error('Generating cloudpayments order error!')
    })

  return response.data?.Model?.Url
}
