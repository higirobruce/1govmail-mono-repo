-- attachment_embeddings: chunked embedded text extracted from mail attachments.
-- Hand-authored: prisma migrate dev cannot run against this drifted dev DB, and
-- the HNSW index below must never be dropped by drift detection.
CREATE TABLE "attachment_embeddings" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "chunkText" TEXT NOT NULL,
    "embedding" vector(1024),
    "failed" BOOLEAN NOT NULL DEFAULT false,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "attachment_embeddings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "attachment_embeddings_messageId_partId_chunkIndex_model_key"
    ON "attachment_embeddings"("messageId", "partId", "chunkIndex", "model");
CREATE INDEX "attachment_embeddings_userId_extractedAt_idx"
    ON "attachment_embeddings"("userId", "extractedAt");
CREATE INDEX "attachment_embeddings_embedding_hnsw"
    ON "attachment_embeddings" USING hnsw ("embedding" vector_cosine_ops);

ALTER TABLE "attachment_embeddings"
    ADD CONSTRAINT "attachment_embeddings_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attachment_embeddings"
    ADD CONSTRAINT "attachment_embeddings_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
