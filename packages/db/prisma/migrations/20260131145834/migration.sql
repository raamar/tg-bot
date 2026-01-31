-- CreateEnum
CREATE TYPE "PartnerWithdrawalStatus" AS ENUM ('IN_REVIEW', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "blockReason" TEXT,
ADD COLUMN     "blockedAt" TIMESTAMP(3),
ADD COLUMN     "lastInteractionAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Partner" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "usdtWallet" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerReferral" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerReferral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerWithdrawal" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "PartnerWithdrawalStatus" NOT NULL DEFAULT 'IN_REVIEW',
    "reason" TEXT,
    "receiptUrl" TEXT,
    "receiptKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "PartnerWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Partner_telegramId_key" ON "Partner"("telegramId");

-- CreateIndex
CREATE INDEX "Partner_telegramId_idx" ON "Partner"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerReferral_code_key" ON "PartnerReferral"("code");

-- CreateIndex
CREATE INDEX "PartnerReferral_partnerId_idx" ON "PartnerReferral"("partnerId");

-- CreateIndex
CREATE INDEX "PartnerWithdrawal_partnerId_idx" ON "PartnerWithdrawal"("partnerId");

-- CreateIndex
CREATE INDEX "PartnerWithdrawal_status_idx" ON "PartnerWithdrawal"("status");

-- CreateIndex
CREATE INDEX "PartnerWithdrawal_createdAt_idx" ON "PartnerWithdrawal"("createdAt");

-- CreateIndex
CREATE INDEX "User_refSource_idx" ON "User"("refSource");

-- AddForeignKey
ALTER TABLE "PartnerReferral" ADD CONSTRAINT "PartnerReferral_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerWithdrawal" ADD CONSTRAINT "PartnerWithdrawal_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
