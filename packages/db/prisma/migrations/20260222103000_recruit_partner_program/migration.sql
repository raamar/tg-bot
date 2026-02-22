-- AlterTable
ALTER TABLE "Partner" ADD COLUMN "recruitReferralId" TEXT;

-- CreateEnum
CREATE TYPE "RecruitPartnerWithdrawalStatus" AS ENUM ('IN_REVIEW', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "RecruitPartner" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "usdtWallet" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecruitPartner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitPartnerReferral" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecruitPartnerReferral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitPartnerQualification" (
    "id" TEXT NOT NULL,
    "recruitPartnerId" TEXT NOT NULL,
    "recruitReferralId" TEXT NOT NULL,
    "referredPartnerId" TEXT NOT NULL,
    "qualifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecruitPartnerQualification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitPartnerWithdrawal" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "RecruitPartnerWithdrawalStatus" NOT NULL DEFAULT 'IN_REVIEW',
    "reason" TEXT,
    "receiptUrl" TEXT,
    "receiptKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "RecruitPartnerWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecruitPartner_telegramId_key" ON "RecruitPartner"("telegramId");

-- CreateIndex
CREATE INDEX "RecruitPartner_telegramId_idx" ON "RecruitPartner"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitPartnerReferral_code_key" ON "RecruitPartnerReferral"("code");

-- CreateIndex
CREATE INDEX "RecruitPartnerReferral_partnerId_idx" ON "RecruitPartnerReferral"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitPartnerQualification_referredPartnerId_key" ON "RecruitPartnerQualification"("referredPartnerId");

-- CreateIndex
CREATE INDEX "RecruitPartnerQualification_recruitPartnerId_idx" ON "RecruitPartnerQualification"("recruitPartnerId");

-- CreateIndex
CREATE INDEX "RecruitPartnerQualification_recruitReferralId_idx" ON "RecruitPartnerQualification"("recruitReferralId");

-- CreateIndex
CREATE INDEX "RecruitPartnerQualification_qualifiedAt_idx" ON "RecruitPartnerQualification"("qualifiedAt");

-- CreateIndex
CREATE INDEX "RecruitPartnerWithdrawal_partnerId_idx" ON "RecruitPartnerWithdrawal"("partnerId");

-- CreateIndex
CREATE INDEX "RecruitPartnerWithdrawal_status_idx" ON "RecruitPartnerWithdrawal"("status");

-- CreateIndex
CREATE INDEX "RecruitPartnerWithdrawal_createdAt_idx" ON "RecruitPartnerWithdrawal"("createdAt");

-- CreateIndex
CREATE INDEX "Partner_recruitReferralId_idx" ON "Partner"("recruitReferralId");

-- AddForeignKey
ALTER TABLE "Partner" ADD CONSTRAINT "Partner_recruitReferralId_fkey" FOREIGN KEY ("recruitReferralId") REFERENCES "RecruitPartnerReferral"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitPartnerReferral" ADD CONSTRAINT "RecruitPartnerReferral_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "RecruitPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitPartnerQualification" ADD CONSTRAINT "RecruitPartnerQualification_recruitPartnerId_fkey" FOREIGN KEY ("recruitPartnerId") REFERENCES "RecruitPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitPartnerQualification" ADD CONSTRAINT "RecruitPartnerQualification_recruitReferralId_fkey" FOREIGN KEY ("recruitReferralId") REFERENCES "RecruitPartnerReferral"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitPartnerQualification" ADD CONSTRAINT "RecruitPartnerQualification_referredPartnerId_fkey" FOREIGN KEY ("referredPartnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitPartnerWithdrawal" ADD CONSTRAINT "RecruitPartnerWithdrawal_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "RecruitPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
