-- Login derives the institution from the address domain instead of a dropdown.
-- Nullable on purpose: a row hand-added on a deployed DB has no mapping yet and
-- must not block this migration; it stays reachable by explicit institution id.
ALTER TABLE "institutions" ADD COLUMN "emailDomain" TEXT;

-- Backfill the seeded registry. These are ADDRESS domains, not mail hosts.
UPDATE "institutions" SET "emailDomain" = 'risa.gov.rw'     WHERE "id" = 'risa';
UPDATE "institutions" SET "emailDomain" = 'minict.gov.rw'   WHERE "id" = 'minict';
UPDATE "institutions" SET "emailDomain" = 'minaffet.gov.rw' WHERE "id" = 'minaffet';

CREATE UNIQUE INDEX "institutions_emailDomain_key" ON "institutions"("emailDomain");
