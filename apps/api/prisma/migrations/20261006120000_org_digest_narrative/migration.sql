-- CreateTable
CREATE TABLE "org_digest_narratives" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_digest_narratives_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "org_digest_narratives_institutionId_idx" ON "org_digest_narratives"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "org_digest_narratives_institutionId_window_key" ON "org_digest_narratives"("institutionId", "window");
