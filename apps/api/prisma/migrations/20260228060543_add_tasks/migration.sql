/*
  Warnings:

  - You are about to alter the column `attendees` on the `calendar_events` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - You are about to alter the column `addresses` on the `contacts` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - You are about to alter the column `emails` on the `contacts` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - You are about to alter the column `phones` on the `contacts` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - You are about to alter the column `tags` on the `contacts` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - You are about to alter the column `attachments` on the `messages` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - You are about to alter the column `bccRecipients` on the `messages` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - You are about to alter the column `ccRecipients` on the `messages` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - You are about to alter the column `flags` on the `messages` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - You are about to alter the column `inlineImages` on the `messages` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - You are about to alter the column `tags` on the `messages` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - You are about to alter the column `toRecipients` on the `messages` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.

*/
-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'TODO',
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "dueDate" DATETIME,
    "completedAt" DATETIME,
    "linkedMessageId" TEXT,
    "linkedSubject" TEXT,
    "assignedToEmail" TEXT,
    "assignedToName" TEXT,
    "assignedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "tasks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_calendar_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "zimbraId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "startAt" DATETIME NOT NULL,
    "endAt" DATETIME NOT NULL,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "recurrenceRule" TEXT,
    "organizer" TEXT,
    "attendees" JSONB NOT NULL DEFAULT [],
    "calendarName" TEXT,
    "color" TEXT,
    "syncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "calendar_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_calendar_events" ("allDay", "attendees", "calendarName", "color", "createdAt", "description", "endAt", "id", "isRecurring", "location", "organizer", "recurrenceRule", "startAt", "syncedAt", "title", "updatedAt", "userId", "zimbraId") SELECT "allDay", "attendees", "calendarName", "color", "createdAt", "description", "endAt", "id", "isRecurring", "location", "organizer", "recurrenceRule", "startAt", "syncedAt", "title", "updatedAt", "userId", "zimbraId" FROM "calendar_events";
DROP TABLE "calendar_events";
ALTER TABLE "new_calendar_events" RENAME TO "calendar_events";
CREATE INDEX "calendar_events_userId_startAt_idx" ON "calendar_events"("userId", "startAt");
CREATE UNIQUE INDEX "calendar_events_userId_zimbraId_key" ON "calendar_events"("userId", "zimbraId");
CREATE TABLE "new_contacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "zimbraId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "fullName" TEXT,
    "nickname" TEXT,
    "company" TEXT,
    "jobTitle" TEXT,
    "emails" JSONB NOT NULL DEFAULT [],
    "phones" JSONB NOT NULL DEFAULT [],
    "addresses" JSONB NOT NULL DEFAULT [],
    "notes" TEXT,
    "photoUrl" TEXT,
    "tags" JSONB NOT NULL DEFAULT [],
    "syncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "contacts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_contacts" ("addresses", "company", "createdAt", "emails", "firstName", "fullName", "id", "jobTitle", "lastName", "nickname", "notes", "phones", "photoUrl", "syncedAt", "tags", "updatedAt", "userId", "zimbraId") SELECT "addresses", "company", "createdAt", "emails", "firstName", "fullName", "id", "jobTitle", "lastName", "nickname", "notes", "phones", "photoUrl", "syncedAt", "tags", "updatedAt", "userId", "zimbraId" FROM "contacts";
DROP TABLE "contacts";
ALTER TABLE "new_contacts" RENAME TO "contacts";
CREATE INDEX "contacts_userId_idx" ON "contacts"("userId");
CREATE UNIQUE INDEX "contacts_userId_zimbraId_key" ON "contacts"("userId", "zimbraId");
CREATE TABLE "new_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "zimbraId" TEXT NOT NULL,
    "conversationId" TEXT,
    "subject" TEXT,
    "snippet" TEXT,
    "bodyText" TEXT,
    "bodyHtml" TEXT,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "toRecipients" JSONB NOT NULL,
    "ccRecipients" JSONB NOT NULL DEFAULT [],
    "bccRecipients" JSONB NOT NULL DEFAULT [],
    "replyTo" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "isStarred" BOOLEAN NOT NULL DEFAULT false,
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "attachments" JSONB NOT NULL DEFAULT [],
    "inlineImages" JSONB,
    "flags" JSONB NOT NULL DEFAULT [],
    "tags" JSONB NOT NULL DEFAULT [],
    "sentAt" DATETIME,
    "receivedAt" DATETIME NOT NULL,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "messages_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "folders" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_messages" ("attachments", "bccRecipients", "bodyHtml", "bodyText", "ccRecipients", "conversationId", "createdAt", "flags", "folderId", "fromEmail", "fromName", "hasAttachments", "id", "inlineImages", "isDraft", "isRead", "isStarred", "receivedAt", "replyTo", "sentAt", "snippet", "subject", "syncedAt", "tags", "toRecipients", "updatedAt", "userId", "zimbraId") SELECT "attachments", "bccRecipients", "bodyHtml", "bodyText", "ccRecipients", "conversationId", "createdAt", "flags", "folderId", "fromEmail", "fromName", "hasAttachments", "id", "inlineImages", "isDraft", "isRead", "isStarred", "receivedAt", "replyTo", "sentAt", "snippet", "subject", "syncedAt", "tags", "toRecipients", "updatedAt", "userId", "zimbraId" FROM "messages";
DROP TABLE "messages";
ALTER TABLE "new_messages" RENAME TO "messages";
CREATE INDEX "messages_userId_folderId_idx" ON "messages"("userId", "folderId");
CREATE INDEX "messages_userId_conversationId_idx" ON "messages"("userId", "conversationId");
CREATE UNIQUE INDEX "messages_userId_zimbraId_key" ON "messages"("userId", "zimbraId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "tasks_userId_idx" ON "tasks"("userId");

-- CreateIndex
CREATE INDEX "tasks_userId_status_idx" ON "tasks"("userId", "status");
