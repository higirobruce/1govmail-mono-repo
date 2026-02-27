-- Initial SQLite schema (migrated from PostgreSQL)
-- Generated for Prisma 7.x / better-sqlite3 driver adapter

-- CreateTable
CREATE TABLE "users" (
    "id"          TEXT     NOT NULL PRIMARY KEY,
    "email"       TEXT     NOT NULL,
    "displayName" TEXT,
    "zimbraHost"  TEXT     NOT NULL,
    "authToken"   TEXT,
    "csrfToken"   TEXT,
    "tokenExpiry" DATETIME,
    "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "sessions" (
    "id"        TEXT     NOT NULL PRIMARY KEY,
    "userId"    TEXT     NOT NULL,
    "token"     TEXT     NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    CONSTRAINT "sessions_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "folders" (
    "id"          TEXT     NOT NULL PRIMARY KEY,
    "userId"      TEXT     NOT NULL,
    "zimbraId"    TEXT     NOT NULL,
    "name"        TEXT     NOT NULL,
    "path"        TEXT     NOT NULL,
    "parentId"    TEXT,
    "type"        TEXT     NOT NULL DEFAULT 'MAIL',
    "unreadCount" INTEGER  NOT NULL DEFAULT 0,
    "totalCount"  INTEGER  NOT NULL DEFAULT 0,
    "color"       TEXT,
    "syncedAt"    DATETIME,
    "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   DATETIME NOT NULL,
    CONSTRAINT "folders_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "messages" (
    "id"             TEXT     NOT NULL PRIMARY KEY,
    "userId"         TEXT     NOT NULL,
    "folderId"       TEXT     NOT NULL,
    "zimbraId"       TEXT     NOT NULL,
    "conversationId" TEXT,
    "subject"        TEXT,
    "snippet"        TEXT,
    "bodyText"       TEXT,
    "bodyHtml"       TEXT,
    "fromEmail"      TEXT     NOT NULL,
    "fromName"       TEXT,
    "toRecipients"   TEXT     NOT NULL,
    "ccRecipients"   TEXT     NOT NULL DEFAULT '[]',
    "bccRecipients"  TEXT     NOT NULL DEFAULT '[]',
    "replyTo"        TEXT,
    "isRead"         BOOLEAN  NOT NULL DEFAULT false,
    "isStarred"      BOOLEAN  NOT NULL DEFAULT false,
    "isDraft"        BOOLEAN  NOT NULL DEFAULT false,
    "hasAttachments" BOOLEAN  NOT NULL DEFAULT false,
    "attachments"    TEXT     NOT NULL DEFAULT '[]',
    "inlineImages"   TEXT,
    "flags"          TEXT     NOT NULL DEFAULT '[]',
    "tags"           TEXT     NOT NULL DEFAULT '[]',
    "sentAt"         DATETIME,
    "receivedAt"     DATETIME NOT NULL,
    "syncedAt"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      DATETIME NOT NULL,
    CONSTRAINT "messages_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "messages_folderId_fkey"
        FOREIGN KEY ("folderId") REFERENCES "folders" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "contacts" (
    "id"        TEXT     NOT NULL PRIMARY KEY,
    "userId"    TEXT     NOT NULL,
    "zimbraId"  TEXT     NOT NULL,
    "firstName" TEXT,
    "lastName"  TEXT,
    "fullName"  TEXT,
    "nickname"  TEXT,
    "company"   TEXT,
    "jobTitle"  TEXT,
    "emails"    TEXT     NOT NULL DEFAULT '[]',
    "phones"    TEXT     NOT NULL DEFAULT '[]',
    "addresses" TEXT     NOT NULL DEFAULT '[]',
    "notes"     TEXT,
    "photoUrl"  TEXT,
    "tags"      TEXT     NOT NULL DEFAULT '[]',
    "syncedAt"  DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "contacts_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "calendar_events" (
    "id"             TEXT     NOT NULL PRIMARY KEY,
    "userId"         TEXT     NOT NULL,
    "zimbraId"       TEXT     NOT NULL,
    "title"          TEXT     NOT NULL,
    "description"    TEXT,
    "location"       TEXT,
    "startAt"        DATETIME NOT NULL,
    "endAt"          DATETIME NOT NULL,
    "allDay"         BOOLEAN  NOT NULL DEFAULT false,
    "isRecurring"    BOOLEAN  NOT NULL DEFAULT false,
    "recurrenceRule" TEXT,
    "organizer"      TEXT,
    "attendees"      TEXT     NOT NULL DEFAULT '[]',
    "calendarName"   TEXT,
    "color"          TEXT,
    "syncedAt"       DATETIME,
    "createdAt"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      DATETIME NOT NULL,
    CONSTRAINT "calendar_events_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key"               ON "users"("email");
CREATE UNIQUE INDEX "sessions_token_key"             ON "sessions"("token");
CREATE INDEX        "sessions_userId_idx"             ON "sessions"("userId");
CREATE UNIQUE INDEX "folders_userId_zimbraId_key"    ON "folders"("userId", "zimbraId");
CREATE INDEX        "folders_userId_idx"              ON "folders"("userId");
CREATE UNIQUE INDEX "messages_userId_zimbraId_key"   ON "messages"("userId", "zimbraId");
CREATE INDEX        "messages_userId_folderId_idx"    ON "messages"("userId", "folderId");
CREATE INDEX        "messages_userId_convId_idx"      ON "messages"("userId", "conversationId");
CREATE UNIQUE INDEX "contacts_userId_zimbraId_key"   ON "contacts"("userId", "zimbraId");
CREATE INDEX        "contacts_userId_idx"             ON "contacts"("userId");
CREATE UNIQUE INDEX "cal_events_userId_zimbraId_key" ON "calendar_events"("userId", "zimbraId");
CREATE INDEX        "cal_events_userId_startAt_idx"  ON "calendar_events"("userId", "startAt");
