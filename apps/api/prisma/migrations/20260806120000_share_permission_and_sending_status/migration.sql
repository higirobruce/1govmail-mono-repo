-- CreateEnum
CREATE TYPE "SharePermission" AS ENUM ('VIEW', 'EDIT');

-- AlterTable
-- Share links default to read-only; edit rights must be granted explicitly.
ALTER TABLE "documents" ADD COLUMN "sharePermission" "SharePermission" NOT NULL DEFAULT 'VIEW';

-- AlterEnum
-- SENDING is the in-flight claim state used to stop overlapping cron runs
-- from dispatching the same scheduled message twice.
ALTER TYPE "ScheduledMessageStatus" ADD VALUE 'SENDING' AFTER 'PENDING';
