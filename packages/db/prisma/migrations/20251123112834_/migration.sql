-- CreateTable
CREATE TABLE "ChatJoinRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatJoinRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatJoinRequest_chatId_idx" ON "ChatJoinRequest"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatJoinRequest_userId_chatId_key" ON "ChatJoinRequest"("userId", "chatId");

-- AddForeignKey
ALTER TABLE "ChatJoinRequest" ADD CONSTRAINT "ChatJoinRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
