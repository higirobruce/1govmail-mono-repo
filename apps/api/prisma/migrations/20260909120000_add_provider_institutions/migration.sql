-- institutions registry + per-user provider tag
CREATE TABLE "institutions" (
    "id"        TEXT NOT NULL,
    "label"     TEXT NOT NULL,
    "provider"  TEXT NOT NULL,
    "host"      TEXT NOT NULL,
    "ewsDomain" TEXT,
    "enabled"   BOOLEAN NOT NULL DEFAULT true,
    "position"  INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "institutions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "users" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'zimbra';
ALTER TABLE "users" ADD COLUMN "institutionId" TEXT;

-- Seed the current registry. MINAFFET is EWS (webmail host + NTLM domain) —
-- the old frontend list wrongly treated it as Zimbra.
INSERT INTO "institutions" ("id","label","provider","host","ewsDomain","enabled","position") VALUES
  ('risa',     'RISA',     'zimbra', 'mail.risa.gov.rw:8443',   NULL,       true, 0),
  ('minict',   'MINICT',   'zimbra', 'mail.minict.gov.rw',      NULL,       true, 1),
  ('minaffet', 'MINAFFET', 'ews',    'webmail.minaffet.gov.rw', 'MINAFFET', true, 2);
