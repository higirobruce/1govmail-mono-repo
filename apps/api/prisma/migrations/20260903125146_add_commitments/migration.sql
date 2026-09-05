-- CreateTable
CREATE TABLE "commitments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "dueHint" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "suggestResolve" BOOLEAN NOT NULL DEFAULT false,
    "hintMessageId" TEXT,
    "taskId" TEXT,
    "textHash" TEXT NOT NULL,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "commitments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commitments_userId_status_lastActivityAt_idx" ON "commitments"("userId", "status", "lastActivityAt");

-- CreateIndex
CREATE UNIQUE INDEX "commitments_userId_type_textHash_key" ON "commitments"("userId", "type", "textHash");

-- AddForeignKey
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
