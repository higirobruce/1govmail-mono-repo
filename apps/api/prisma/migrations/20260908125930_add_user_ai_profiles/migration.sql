-- user_ai_profiles: account-level AI personalization (instructions + identity card).
-- Hand-authored per the drifted-dev-DB workflow.
CREATE TABLE "user_ai_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "instructions" TEXT,
    "jobTitle" TEXT,
    "institution" TEXT,
    "department" TEXT,
    "language" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_ai_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_ai_profiles_userId_key" ON "user_ai_profiles"("userId");
ALTER TABLE "user_ai_profiles"
    ADD CONSTRAINT "user_ai_profiles_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
