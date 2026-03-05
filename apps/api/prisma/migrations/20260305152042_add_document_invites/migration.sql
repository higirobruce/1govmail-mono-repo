-- CreateEnum
CREATE TYPE "InviteRole" AS ENUM ('VIEWER', 'EDITOR');

-- CreateTable
CREATE TABLE "document_invites" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "invitedEmail" TEXT NOT NULL,
    "invitedBy" TEXT NOT NULL,
    "role" "InviteRole" NOT NULL DEFAULT 'EDITOR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_invites_invitedEmail_idx" ON "document_invites"("invitedEmail");

-- CreateIndex
CREATE UNIQUE INDEX "document_invites_documentId_invitedEmail_key" ON "document_invites"("documentId", "invitedEmail");

-- AddForeignKey
ALTER TABLE "document_invites" ADD CONSTRAINT "document_invites_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_invites" ADD CONSTRAINT "document_invites_invitedBy_fkey" FOREIGN KEY ("invitedBy") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
