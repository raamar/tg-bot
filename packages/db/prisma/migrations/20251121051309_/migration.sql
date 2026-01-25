-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'PAID', 'CANCELED');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'CANCELED');

-- CreateEnum
CREATE TYPE "StepVisitSource" AS ENUM ('CLICK', 'REMINDER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "OfferKey" AS ENUM ('main_full_price', 'main_discount_50', 'main_discount_50_2', 'main_discount_50_3', 'main_discount_50_4', 'main_discount_50_5', 'main_discount_50_6', 'main_last_chance', 'main_last_chance_2');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "refSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "currentStepId" TEXT,
    "currentScenario" TEXT,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "subscribed" BOOLEAN NOT NULL DEFAULT false,
    "agreed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "offerInstanceId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "url" TEXT,
    "status" "PaymentStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferInstance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "offerKey" "OfferKey" NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "initialPrice" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "lastMessageChatId" TEXT,
    "lastMessageId" INTEGER,
    "lastMessageBullJobId" TEXT,

    CONSTRAINT "OfferInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "scenarioKey" TEXT,
    "status" "ReminderStatus" NOT NULL DEFAULT 'PENDING',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "bullJobId" TEXT,

    CONSTRAINT "ReminderSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepVisit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "source" "StepVisitSource" NOT NULL DEFAULT 'CLICK',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StepVisit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateIndex
CREATE INDEX "User_telegramId_idx" ON "User"("telegramId");

-- CreateIndex
CREATE INDEX "Payment_userId_idx" ON "Payment"("userId");

-- CreateIndex
CREATE INDEX "Payment_offerInstanceId_idx" ON "Payment"("offerInstanceId");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "OfferInstance_userId_idx" ON "OfferInstance"("userId");

-- CreateIndex
CREATE INDEX "OfferInstance_offerKey_idx" ON "OfferInstance"("offerKey");

-- CreateIndex
CREATE INDEX "OfferInstance_status_idx" ON "OfferInstance"("status");

-- CreateIndex
CREATE INDEX "ReminderSubscription_userId_idx" ON "ReminderSubscription"("userId");

-- CreateIndex
CREATE INDEX "ReminderSubscription_status_idx" ON "ReminderSubscription"("status");

-- CreateIndex
CREATE INDEX "ReminderSubscription_scheduledAt_idx" ON "ReminderSubscription"("scheduledAt");

-- CreateIndex
CREATE INDEX "StepVisit_userId_stepId_idx" ON "StepVisit"("userId", "stepId");

-- CreateIndex
CREATE INDEX "StepVisit_createdAt_idx" ON "StepVisit"("createdAt");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_offerInstanceId_fkey" FOREIGN KEY ("offerInstanceId") REFERENCES "OfferInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferInstance" ADD CONSTRAINT "OfferInstance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderSubscription" ADD CONSTRAINT "ReminderSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepVisit" ADD CONSTRAINT "StepVisit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
