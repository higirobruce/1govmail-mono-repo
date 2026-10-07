-- AlterTable
ALTER TABLE "calendar_events" ADD COLUMN "icalUid" TEXT;

-- CreateTable
CREATE TABLE "meeting_minutes" (
    "id"                TEXT NOT NULL,
    "icalUid"           TEXT NOT NULL,
    "occurrenceStartAt" TIMESTAMP(3) NOT NULL,
    "documentId"        TEXT NOT NULL,
    "createdBy"         TEXT NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_minutes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meeting_minutes_icalUid_occurrenceStartAt_key" ON "meeting_minutes"("icalUid", "occurrenceStartAt");

-- CreateIndex
CREATE INDEX "meeting_minutes_documentId_idx" ON "meeting_minutes"("documentId");

-- AddForeignKey
ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
