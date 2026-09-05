CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "message_embeddings" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "chunkText" TEXT NOT NULL,
    "embedding" vector(1024),
    "failed" BOOLEAN NOT NULL DEFAULT false,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_embeddings_userId_extractedAt_idx" ON "message_embeddings"("userId", "extractedAt");

-- CreateIndex
CREATE UNIQUE INDEX "message_embeddings_messageId_chunkIndex_model_key" ON "message_embeddings"("messageId", "chunkIndex", "model");

-- AddForeignKey
ALTER TABLE "message_embeddings" ADD CONSTRAINT "message_embeddings_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_embeddings" ADD CONSTRAINT "message_embeddings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Approximate-NN index for cosine retrieval. Filtered per-user scans over a
-- 90-day window are a few thousand rows — comfortable for HNSW.
CREATE INDEX "message_embeddings_embedding_hnsw_idx"
  ON "message_embeddings" USING hnsw ("embedding" vector_cosine_ops);
