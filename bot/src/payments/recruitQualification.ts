import { prisma } from '../prisma'

export async function ensureRecruitPartnerQualificationByUserId(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { refSource: true },
  })

  if (!user?.refSource) return

  const partnerReferral = await prisma.partnerReferral.findUnique({
    where: { code: user.refSource },
    select: {
      partner: {
        select: {
          id: true,
          recruitReferral: {
            select: {
              id: true,
              partnerId: true,
            },
          },
        },
      },
    },
  })

  const referredPartner = partnerReferral?.partner
  const recruitReferral = referredPartner?.recruitReferral
  if (!referredPartner || !recruitReferral) return

  await prisma.recruitPartnerQualification.upsert({
    where: { referredPartnerId: referredPartner.id },
    update: {},
    create: {
      recruitPartnerId: recruitReferral.partnerId,
      recruitReferralId: recruitReferral.id,
      referredPartnerId: referredPartner.id,
    },
  })
}
