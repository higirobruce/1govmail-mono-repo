-- CreateTable
CREATE TABLE "snoozed_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "snoozedUntil" DATETIME NOT NULL,
    "originalFolderId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "snoozed_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "scheduled_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "sendAt" DATETIME NOT NULL,
    "to" JSONB NOT NULL,
    "cc" JSONB NOT NULL DEFAULT [],
    "bcc" JSONB NOT NULL DEFAULT [],
    "subject" TEXT,
    "body" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorMsg" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "scheduled_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "email_templates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "email_templates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "mail_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "mail_rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "muted_conversations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "muted_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "snoozed_messages_userId_idx" ON "snoozed_messages"("userId");

-- CreateIndex
CREATE INDEX "snoozed_messages_snoozedUntil_idx" ON "snoozed_messages"("snoozedUntil");

-- CreateIndex
CREATE INDEX "scheduled_messages_userId_idx" ON "scheduled_messages"("userId");

-- CreateIndex
CREATE INDEX "scheduled_messages_status_sendAt_idx" ON "scheduled_messages"("status", "sendAt");

-- CreateIndex
CREATE INDEX "email_templates_userId_idx" ON "email_templates"("userId");

-- CreateIndex
CREATE INDEX "mail_rules_userId_idx" ON "mail_rules"("userId");

-- CreateIndex
CREATE INDEX "muted_conversations_userId_idx" ON "muted_conversations"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "muted_conversations_userId_conversationId_key" ON "muted_conversations"("userId", "conversationId");
