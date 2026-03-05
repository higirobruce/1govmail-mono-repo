-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "coverColor" TEXT,
ADD COLUMN     "isFavorite" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "documents_userId_isFavorite_idx" ON "documents"("userId", "isFavorite");
