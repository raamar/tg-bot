import { prisma } from '../prisma'

type QualifiedRow = {
  referredPartnerId: string
  recruitReferralId: string
  recruitPartnerId: string
}

const chunk = <T>(list: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

async function main() {
  const dryRun = process.env.DRY_RUN !== '0'
  const startedAt = Date.now()

  const recruitedPartnersTotal = await prisma.partner.count({
    where: { recruitReferralId: { not: null } },
  })

  const qualifiedRows = await prisma.$queryRaw<QualifiedRow[]>`
    SELECT DISTINCT
      p.id AS "referredPartnerId",
      p."recruitReferralId" AS "recruitReferralId",
      rr."partnerId" AS "recruitPartnerId"
    FROM "Partner" p
    JOIN "RecruitPartnerReferral" rr ON rr.id = p."recruitReferralId"
    JOIN "PartnerReferral" pr ON pr."partnerId" = p.id
    JOIN "User" u ON u."refSource" = pr.code
    JOIN "Payment" pay ON pay."userId" = u.id AND pay.status = 'PAID'
    WHERE p."recruitReferralId" IS NOT NULL
  `

  const candidateIds = qualifiedRows.map((row) => row.referredPartnerId)
  const existingIds = new Set<string>()
  for (const ids of chunk(candidateIds, 1000)) {
    const existing = await prisma.recruitPartnerQualification.findMany({
      where: { referredPartnerId: { in: ids } },
      select: { referredPartnerId: true },
    })
    existing.forEach((item) => existingIds.add(item.referredPartnerId))
  }

  const toCreate = qualifiedRows.filter((row) => !existingIds.has(row.referredPartnerId))

  console.log('=== Recruit Qualification Backfill ===')
  console.log(`DRY_RUN=${dryRun ? '1' : '0'}`)
  console.log(`Partners with recruit source: ${recruitedPartnersTotal}`)
  console.log(`Qualified candidates found: ${qualifiedRows.length}`)
  console.log(`Already qualified in DB: ${existingIds.size}`)
  console.log(`To create now: ${toCreate.length}`)

  if (!dryRun && toCreate.length > 0) {
    for (const rows of chunk(toCreate, 1000)) {
      await prisma.recruitPartnerQualification.createMany({
        data: rows.map((row) => ({
          referredPartnerId: row.referredPartnerId,
          recruitReferralId: row.recruitReferralId,
          recruitPartnerId: row.recruitPartnerId,
        })),
        skipDuplicates: true,
      })
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(2)
  console.log(`Done in ${elapsedSec}s`)
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {})
  })
