-- Fill in users.institutionId for accounts that predate domain-derived login.
--
-- The 20260918120000 migration backfilled institutions.emailDomain, not this
-- column. users.institutionId is written only at login (auth.service.ts), so
-- every account that has not signed in since that feature shipped still has
-- NULL — 19 of 27 users on 10.10.94.155 at the time of writing. Anything that
-- scopes by institution (the org digest, in particular) cannot be correct while
-- that is true.
--
-- Derivation is exactly what login does: match the address domain against the
-- institution registry.
--   * `IS NULL` guard  -> idempotent, and never overwrites a value login set.
--   * lower()          -> addresses stored in mixed case still match.
--   * split_part on @  -> an exact domain match, so sub.risa.gov.rw does NOT
--                         resolve to risa.gov.rw.
--   * no match         -> the user stays NULL rather than being guessed at.
--                         Failing closed is what the institution filter needs.
UPDATE "users" u
   SET "institutionId" = i."id"
  FROM "institutions" i
 WHERE lower(split_part(u."email", '@', 2)) = i."emailDomain"
   AND u."institutionId" IS NULL;

-- institutionId has been read but unindexed since domain-derived login; the org
-- digest filters every one of its queries on it.
CREATE INDEX IF NOT EXISTS "users_institutionId_idx" ON "users"("institutionId");
