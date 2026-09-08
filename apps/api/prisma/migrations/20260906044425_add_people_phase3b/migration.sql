-- CreateTable
CREATE TABLE "ai_generations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sources" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT NOT NULL,
    "sourceAnchor" TIMESTAMP(3) NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_generations_userId_kind_idx" ON "ai_generations"("userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ai_generations_userId_kind_targetKey_key" ON "ai_generations"("userId", "kind", "targetKey");

-- CreateIndex
CREATE INDEX "messages_userId_fromEmail_receivedAt_idx" ON "messages"("userId", "fromEmail", "receivedAt");

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
