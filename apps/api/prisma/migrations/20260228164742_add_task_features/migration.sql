-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "attachments" JSONB;
ALTER TABLE "tasks" ADD COLUMN "recurrence" TEXT;
ALTER TABLE "tasks" ADD COLUMN "recurrenceEndDate" DATETIME;
ALTER TABLE "tasks" ADD COLUMN "reminderAt" DATETIME;
ALTER TABLE "tasks" ADD COLUMN "reminderSentAt" DATETIME;
