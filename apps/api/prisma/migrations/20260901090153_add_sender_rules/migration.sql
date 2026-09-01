-- CreateEnum
CREATE TYPE "SenderRuleType" AS ENUM ('BLOCK', 'ALLOW');

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT,
    "resourceId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sender_rules" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "SenderRuleType" NOT NULL,
    "address" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sender_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_comments" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "anchorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doc_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_comment_reactions" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doc_comment_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_versions" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doc_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_activity" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "userId" TEXT,
    "actorName" TEXT,
    "type" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doc_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "sender_rules_userId_idx" ON "sender_rules"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "sender_rules_userId_type_address_key" ON "sender_rules"("userId", "type", "address");

-- CreateIndex
CREATE INDEX "doc_comments_documentId_idx" ON "doc_comments"("documentId");

-- CreateIndex
CREATE INDEX "doc_comments_anchorId_idx" ON "doc_comments"("anchorId");

-- CreateIndex
CREATE INDEX "doc_comment_reactions_commentId_idx" ON "doc_comment_reactions"("commentId");

-- CreateIndex
CREATE UNIQUE INDEX "doc_comment_reactions_commentId_userId_emoji_key" ON "doc_comment_reactions"("commentId", "userId", "emoji");

-- CreateIndex
CREATE INDEX "doc_versions_documentId_idx" ON "doc_versions"("documentId");

-- CreateIndex
CREATE INDEX "doc_activity_documentId_idx" ON "doc_activity"("documentId");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sender_rules" ADD CONSTRAINT "sender_rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "doc_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_comment_reactions" ADD CONSTRAINT "doc_comment_reactions_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "doc_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_comment_reactions" ADD CONSTRAINT "doc_comment_reactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_versions" ADD CONSTRAINT "doc_versions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_versions" ADD CONSTRAINT "doc_versions_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_activity" ADD CONSTRAINT "doc_activity_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_activity" ADD CONSTRAINT "doc_activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
