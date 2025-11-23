import { prisma } from '../prisma'

const REQUIRED_CHAT_IDS = ['-1002961920513', '-1002951363889']

export const hasJoinRequestsForAllRequiredChats = async (userId: string) => {
  const requests = await prisma.chatJoinRequest.findMany({
    where: {
      userId,
      chatId: { in: REQUIRED_CHAT_IDS },
    },
    select: { chatId: true },
  })

  const set = new Set(requests.map((r) => r.chatId))
  return REQUIRED_CHAT_IDS.every((id) => set.has(id))
}
