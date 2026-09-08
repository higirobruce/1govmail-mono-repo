-- CreateTable
CREATE TABLE "document_embeddings" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "chunkText" TEXT NOT NULL,
    "embedding" vector(1024),
    "failed" BOOLEAN NOT NULL DEFAULT false,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_embeddings_documentId_idx" ON "document_embeddings"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "document_embeddings_documentId_chunkIndex_model_key" ON "document_embeddings"("documentId", "chunkIndex", "model");

-- AddForeignKey
ALTER TABLE "document_embeddings" ADD CONSTRAINT "document_embeddings_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written: Prisma cannot represent an index on an Unsupported() column.
CREATE INDEX "document_embeddings_embedding_hnsw_idx"
  ON "document_embeddings" USING hnsw ("embedding" vector_cosine_ops);
