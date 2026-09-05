-- CreateTable
CREATE TABLE "message_cards" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "gist" TEXT NOT NULL,
    "asksOfMe" JSONB NOT NULL DEFAULT '[]',
    "deadlines" JSONB NOT NULL DEFAULT '[]',
    "commitmentsIMade" JSONB NOT NULL DEFAULT '[]',
    "waitingOn" TEXT,
    "importance" TEXT NOT NULL,
    "injectionSuspected" BOOLEAN NOT NULL DEFAULT false,
    "failed" BOOLEAN NOT NULL DEFAULT false,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_cards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "message_cards_messageId_key" ON "message_cards"("messageId");

-- CreateIndex
CREATE INDEX "message_cards_userId_extractedAt_idx" ON "message_cards"("userId", "extractedAt");

-- AddForeignKey
ALTER TABLE "message_cards" ADD CONSTRAINT "message_cards_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_cards" ADD CONSTRAINT "message_cards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
