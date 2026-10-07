-- Per-document control over appearing on the organisation digest.
--
-- New documents default to visible: the digest exists so colleagues can see
-- what the institution is working on, and opting in one at a time would leave
-- it empty.
ALTER TABLE "documents" ADD COLUMN "orgVisible" BOOLEAN NOT NULL DEFAULT true;

-- Existing documents keep exactly the visibility they already had.
--
-- The column default applies only to rows inserted after this migration, so
-- without this statement every historical document would be announced at once.
-- On 10.10.94.155 that measured as 58 documents whose authors never had the
-- option to opt out — including an open security-vulnerability report, a
-- commercial contract, and several working files titled "Untitled".
--
-- Setting them all to false instead would be the opposite error: the 19
-- documents the digest already announces would silently disappear from it.
-- So each existing row keeps its current state — shared or invited means
-- visible, anything else means not.
UPDATE "documents" d
   SET "orgVisible" = (
     d."isShared" = true
     OR EXISTS (SELECT 1 FROM "document_invites" i WHERE i."documentId" = d."id")
   );

CREATE INDEX IF NOT EXISTS "documents_orgVisible_idx" ON "documents"("orgVisible");
