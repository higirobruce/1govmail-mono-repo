# 1Gov Mail — System Architecture

> **Audience:** Engineers and maintainers who need an end-to-end understanding of the system before making changes.
> **Last updated:** March 2026
> **Version:** 1.4.x
>
> **See also:** [DEPLOYMENT.md](DEPLOYMENT.md) — build pipeline, CI/CD, release process, and hosting runbooks.

---

## Table of Contents

1. [High-Level Overview](#1-high-level-overview)
2. [Monorepo Layout](#2-monorepo-layout)
3. [Backend — NestJS API](#3-backend--nestjs-api)
4. [Database — Prisma + SQLite](#4-database--prisma--sqlite)
5. [Frontend — Next.js Web App](#5-frontend--nextjs-web-app)
6. [Desktop — Electron Shell](#6-desktop--electron-shell)
7. [Authentication Flow](#7-authentication-flow)
8. [Zimbra Integration Layer](#8-zimbra-integration-layer)
9. [Real-Time Collaboration (Docs)](#9-real-time-collaboration-docs)
10. [Background Jobs & Schedulers](#10-background-jobs--schedulers)
11. [API Endpoint Reference](#11-api-endpoint-reference)
12. [Data Flow Diagrams](#12-data-flow-diagrams)
13. [Environment Variables](#13-environment-variables)
14. [Key Architectural Decisions](#14-key-architectural-decisions)
15. [Maintenance Guide](#15-maintenance-guide)

---

## 1. High-Level Overview

1Gov Mail is a **Zimbra front-end** — it does not store email natively. All mail, contacts, and calendar data lives in a Zimbra server; this system provides a modern UI layer with its own local persistence layer (SQLite) for enrichment features that Zimbra does not support (tasks, docs, snooze, scheduled send, notifications, contact groups, templates, rules).

```
┌─────────────────────────────────────────────────────────────────┐
│                          End User                               │
└────────────┬──────────────────────┬───────────────────────────-─┘
             │  Browser (web)       │  Desktop (Electron)
             ▼                      ▼
┌────────────────────┐   ┌──────────────────────────────────────┐
│  Next.js 16        │   │  Electron 34                         │
│  apps/web          │   │  apps/desktop                        │
│  :3000             │   │  Bundles web (:3456) + api (:3457)   │
└────────┬───────────┘   └───────────────┬──────────────────────┘
         │  REST (HTTP/JSON)             │  REST (loopback)
         ▼                              ▼
┌────────────────────────────────────────────────────────────────┐
│  NestJS 11  —  apps/api  (:3001)                               │
│                                                                │
│  AuthModule  MailModule  ContactsModule  CalendarModule        │
│  TasksModule  SettingsModule  NotificationsModule  DocsModule  │
│  ZimbraModule  PrismaModule  CollabModule                      │
└────────┬────────────────────────┬──────────────────────────────┘
         │  Prisma 7 / SQLite     │  Axios SOAP/HTTP
         ▼                        ▼
┌────────────────┐      ┌─────────────────────────────────────┐
│  SQLite DB     │      │  Zimbra Server (external)           │
│  dev.db        │      │  SOAP API  /service/soap            │
│  (local cache) │      │  Attachment API  /service/home/~/?  │
└────────────────┘      └─────────────────────────────────────┘
                                    ▲
         Hocuspocus WS (:1234)      │ (calendar GAL search, auth)
┌────────────────────┐             │
│  TipTap / Yjs CRDT │─────────────┘ (not used directly)
│  @hocuspocus/server│
└────────────────────┘
```

### Runtime ports summary

| Service | Dev port | Prod port (Desktop) |
|---------|----------|---------------------|
| Next.js web | 3000 | 3456 |
| NestJS API | 3001 | 3457 |
| Hocuspocus WS | 1234 | 1234 |

---

## 2. Monorepo Layout

**Toolchain:** pnpm workspaces, Node ≥ 20, pnpm ≥ 10.29.3

```
email-client/
├── apps/
│   ├── web/          Next.js 16 — browser UI
│   ├── api/          NestJS 11 — REST API + WebSocket collab server
│   └── desktop/      Electron 34 — desktop wrapper
├── packages/
│   └── shared/       Shared TypeScript types (v0.0.1, minimal)
├── pnpm-workspace.yaml
├── CHANGELOG.md
└── ARCHITECTURE.md   ← this file
```

### apps/api — internal structure

```
apps/api/src/
├── main.ts                  Express bootstrap + Hocuspocus startup
├── app.module.ts            Root NestJS module (imports all below)
├── auth/                    JWT auth, 2FA, login/logout
├── zimbra/                  All Zimbra SOAP calls (single service, 1600 lines)
├── prisma/                  PrismaService (singleton, better-sqlite3 adapter)
├── mail/                    Folder/message CRUD, snooze, scheduled send, templates, rules
├── contacts/                Contact CRUD + distribution group management
├── calendar/                Calendar event CRUD, free/busy, RSVP
├── tasks/                   Task CRUD, subtasks, comments, attachments, reminders
├── settings/                Prefs, identity, signatures, password change
├── notifications/           In-app notification CRUD + unread count
├── docs/                    Document CRUD, sharing, Yjs collab
├── collab/                  Hocuspocus WebSocket server (collab.server.ts)
└── common/                  JwtAuthGuard, AuthenticatedRequest interface
```

### apps/web — internal structure

```
apps/web/
├── app/
│   ├── (app)/              Protected pages (require auth)
│   │   ├── mail/           Main inbox, thread view
│   │   ├── calendar/       Calendar with event management
│   │   ├── contacts/       Contacts + distribution groups
│   │   ├── tasks/          Tasks (list + Kanban board)
│   │   ├── docs/           Collaborative docs editor
│   │   └── settings/       Account preferences, OOO, signatures
│   ├── (auth)/             Public pages
│   │   └── login/          Login + 2FA prompt
│   └── docs/share/[token]/ Public doc share page (no auth)
├── components/
│   ├── layout/             Sidebar, NotificationsBell, ElectronTitleBar
│   ├── mail/               MailList, ThreadView, MailDetail, ComposeModal, QuickReplyBar,
│   │                       AttachmentLightbox, KeyboardShortcutsModal, SnoozeModal
│   ├── tasks/              TaskModal (Sheet), subtask/comment editors
│   ├── docs/               DocsEditor (TipTap v3 + Hocuspocus)
│   ├── providers/          ThemeProvider (dark/light/system)
│   ├── tour/               Onboarding
│   └── ui/                 shadcn/ui component library (button, dialog, sheet, popover…)
├── stores/
│   ├── auth.store.ts       Zustand — user, token, isAuthenticated (persisted to localStorage)
│   ├── confirm.store.ts    Zustand — global confirm dialog (callback pattern, not Promise)
│   └── theme.store.ts      Zustand — light | dark | system
├── hooks/
│   └── useKeyboardShortcuts.ts   j/k/c/r/a/f/s/e/d/u/Esc/?/⌘K shortcuts
└── lib/
    ├── api.ts              Centralized fetch client — all API calls live here
    └── mock-data.ts        Static fixtures for NEXT_PUBLIC_USE_MOCK=true mode
```

---

## 3. Backend — NestJS API

### Module dependency map

```
AppModule
 ├── PrismaModule          (global — injected by all other modules)
 ├── AuthModule            depends on: ZimbraModule, PrismaModule, JwtModule
 ├── ZimbraModule          no NestJS deps (pure axios SOAP client)
 ├── MailModule            depends on: ZimbraModule, PrismaModule, ScheduleModule
 ├── ContactsModule        depends on: ZimbraModule, PrismaModule
 ├── CalendarModule        depends on: ZimbraModule, PrismaModule
 ├── TasksModule           depends on: ZimbraModule, PrismaModule, ScheduleModule
 ├── SettingsModule        depends on: ZimbraModule, PrismaModule
 ├── NotificationsModule   depends on: PrismaModule
 ├── DocsModule            depends on: PrismaModule
 └── CollabModule          (standalone — started outside NestJS HTTP lifecycle)
```

### Module responsibilities

| Module | Controller prefix | Key responsibilities |
|--------|------------------|---------------------|
| **Auth** | `/auth` | Login (Zimbra SOAP AuthRequest), 2FA (TOTP), JWT issuance, session management |
| **Zimbra** | *(no controller)* | All Zimbra SOAP calls — single service injected everywhere |
| **Mail** | `/mail` | Message list/fetch/search, send (with attachments), drafts, snooze, scheduled send, templates, mail rules, mute, bulk ops |
| **Contacts** | `/contacts` | Contact CRUD (synced from/to Zimbra), autocomplete, distribution groups (local SQLite only) |
| **Calendar** | `/calendar` | Event CRUD (synced from/to Zimbra), free/busy lookup (single + batch), RSVP |
| **Tasks** | `/tasks` | Task CRUD, subtasks, comments, file attachments, assignment, due reminders |
| **Settings** | `/settings` | Zimbra prefs, identities, email signatures, password change |
| **Notifications** | `/notifications` | In-app notifications (snooze expired, scheduled sent, task due, event soon) |
| **Docs** | `/docs` | Collaborative documents (TipTap JSON + Yjs binary), public sharing via shareToken |
| **Collab** | WS `:1234` | Hocuspocus real-time collab server, JWT/share-token auth, DB read/write of Yjs state |

### Request lifecycle

```
HTTP request
  → Express middleware (body-parser 50 MB, CORS)
  → NestJS routing
  → JwtAuthGuard (validates Bearer token via Passport JWT strategy)
  → Controller method (extracts req.user.sub = userId)
  → Service method
    → PrismaService (local SQLite)   ← for enrichment data
    → ZimbraService (axios SOAP)     ← for mail/contacts/calendar
  → Response JSON
```

All protected routes carry `@UseGuards(JwtAuthGuard)`. Public routes (login, shared doc, 2FA) are explicitly excluded.

---

## 4. Database — Prisma 7 + SQLite

### Schema overview

The SQLite database acts as a **local cache and enrichment layer**. Mail, contacts, and calendar data originate in Zimbra; tasks, docs, templates, rules, groups, and notifications are 1Gov Mail-native.

```
User ──┬── Session              (active JWT sessions)
       ├── Folder               (Zimbra folder tree mirror)
       ├── Message              (mail metadata cache + body cache)
       ├── Contact              (Zimbra contact mirror)
       ├── CalendarEvent        (Zimbra calendar mirror)
       ├── Task ──┬── Subtask
       │          └── TaskComment
       ├── SnoozedMessage       (snooze until timestamp)
       ├── ScheduledMessage     (outbox queue, status: PENDING|SENT|FAILED|CANCELLED)
       ├── EmailTemplate        (reusable compose templates)
       ├── MailRule             (if/then filters, conditions + actions as JSON)
       ├── MutedConversation    (muted thread IDs)
       ├── ContactGroup         (distribution lists, members as JSON)
       ├── Notification         (in-app notification feed)
       └── Document             (docs, TipTap JSON + Yjs yjsState bytes)
```

### Key model notes

**Message** — The most complex model. Caches Zimbra message metadata and full body (bodyHtml/bodyText). `bodyHtml`, `bodyText`, `inlineImages`, `attachments` are only populated on `getMessage()` — list endpoints omit them to avoid V8 memory limits when returning 50+ messages.

**ScheduledMessage** — Polled every minute by `MailScheduler`. Status flow: `PENDING → SENT | FAILED`. Cancelled via DELETE endpoint.

**Document** — Stores content twice: `content` (TipTap JSON string, for REST consumers) and `yjsState` (Yjs binary CRDT state, for WebSocket collab). Both are updated by the Hocuspocus database extension.

**ContactGroup** — Purely local (not synced to Zimbra). Members stored as `Json` array `[{ email, name }]`.

### Running migrations

```bash
# Development (generates migration file + applies it)
cd apps/api && npx prisma migrate dev --name <descriptive_name>

# After migrate dev, regenerate the Prisma client
npx prisma generate

# Desktop uses a custom migration runner (main.ts:69-140) that reads
# prisma/migrations/ SQL files and tracks completion in _prisma_migrations.
```

> **Warning:** After adding models or changing the schema, you MUST delete stale TypeScript incremental cache files before the NestJS watcher picks up the new types:
> ```bash
> rm -f apps/api/dist/tsconfig.tsbuildinfo apps/api/dist/tsconfig.build.tsbuildinfo
> ```

---

## 5. Frontend — Next.js Web App

### Routing strategy

Next.js App Router with two route groups:

```
(app)/    — Requires authentication. Layout mounts Sidebar + ThemeProvider.
(auth)/   — Public. Login page only.
docs/share/[token]/  — Public shared document view (no Sidebar, no auth).
```

Pages check `useAuthStore().isAuthenticated` on mount and redirect to `/login` if false. Mock mode (`NEXT_PUBLIC_USE_MOCK=true`) bypasses this check with a pre-seeded user.

### State management

| Store | Persistence | Contents |
|-------|-------------|----------|
| `useAuthStore` | `localStorage` key `auth` | user object, JWT token, isAuthenticated |
| `useConfirmStore` | In-memory | Global confirm dialog state (uses **callback** pattern — not Promise) |
| `useThemeStore` | `localStorage` key `theme` | `'light' \| 'dark' \| 'system'` |

**Confirm dialog pattern** (important for contributors):
```ts
// Correct — callback pattern
useConfirmStore.getState().confirm({
  title: 'Delete draft?',
  destructive: true,
  onConfirm: () => deleteDraft(id),
});

// WRONG — do not await, there is no Promise interface
```

### API client (`lib/api.ts`)

Single `api` object with namespaced methods. All fetch calls go through a shared `request()` helper that:
1. Reads JWT from `localStorage` → injects `Authorization: Bearer {token}`
2. Sets `Content-Type: application/json` (skipped for FormData uploads)
3. On 401 → clears auth store → hard-redirects to `/login`

Namespaces: `api.auth`, `api.mail`, `api.contacts`, `api.calendar`, `api.tasks`, `api.notifications`, `api.docs`, `api.shared`, `api.settings`

### Key component interactions

```
Sidebar
 ├── NavItems (mail / calendar / contacts / tasks / docs / settings)
 │    └── Droppable — accepts 'application/x-govmail-msg' drag data
 │         └── onDrop → sessionStorage.setItem('govmail-prefill-{target}') → router.push
 └── NotificationsBell
      └── Radix Popover, polls GET /notifications every 30s via React Query

app/(app)/mail/page.tsx
 ├── GlobalSearch (⌘K — CommandDialog over all data)
 ├── useKeyboardShortcuts (j/k/c/r/a/f/s/e/d/u/Esc/?)
 ├── MailList
 │    └── MailRow — draggable (sets 'application/x-govmail-msg' on dragStart)
 └── ThreadView (right panel)
      ├── Overview tab (stats, participants, linked tasks, quick actions)
      ├── ThreadMessage × N (expandable, draft badge, delete draft)
      └── QuickReplyBar (single-line → expands → send or open ComposeModal)

app/(app)/calendar/page.tsx
 └── useEffect on mount — checks sessionStorage 'govmail-prefill-calendar'
      → pre-fills CreateEventModal if drag-drop arrived from mail

app/(app)/tasks/page.tsx
 └── useEffect on mount — checks sessionStorage 'govmail-prefill-tasks'
      → opens TaskModal with linkedMessageId if drag-drop arrived from mail
```

### Drag email → calendar/tasks

Cross-page drag-and-drop is architecturally impossible in Next.js (the drop target page is not mounted during the drag). The workaround:
1. User drags a `MailRow` onto the **Calendar** or **Tasks** nav item in the Sidebar.
2. Sidebar `onDrop` stores the email metadata in `sessionStorage` and navigates.
3. The destination page reads `sessionStorage` in a `useEffect` on first mount, opens the pre-filled modal, and removes the key.

### Theme system

`ThemeProvider` (client component in `app/layout.tsx`) reads `useThemeStore` and applies/removes the `dark` class on `document.documentElement`. All colour tokens are OKLCH variables defined in `globals.css` under the `.dark` selector — no component-level changes needed for dark mode.

---

## 6. Desktop — Electron Shell

Electron wraps the web app for distribution as a native application on macOS, Windows, and Linux.

### Process architecture

```
Electron Main Process (apps/desktop/src/main.ts)
 ├── Spawns Next.js process     (builds/serves apps/web at :3456)
 ├── Spawns NestJS API process  (runs apps/api/dist/main.js at :3457)
 ├── Creates BrowserWindow      (loads http://127.0.0.1:3456)
 ├── Sets up system tray menu
 └── Manages JWT secret file    (userData/.jwt-secret, mode 0o600)

Preload (apps/desktop/src/preload.ts)
 └── IPC bridge — contextIsolation safe, exposes limited API to renderer

Renderer (= Next.js web app loaded in BrowserWindow)
 └── Same codebase as web — detects Electron via window.__ELECTRON__
```

### Portable database & migrations

The Electron build ships a **custom SQL migration runner** (bypasses the Prisma Rust binary which doesn't work in packaged Electron builds):
- Reads `.sql` files from `prisma/migrations/*/migration.sql`
- Executes each in a transaction via `better-sqlite3` directly
- Records completion in `_prisma_migrations` table (Prisma-compatible format)
- Runs on every app start — idempotent

The SQLite database file is stored in `app.getPath('userData')` (per OS):
- macOS: `~/Library/Application Support/1Gov Mail/`
- Windows: `%APPDATA%\1Gov Mail\`
- Linux: `~/.config/1Gov Mail/`

### Build targets

```bash
cd apps/desktop

# Development
pnpm dev          # starts Electron with live-reload Next.js + NestJS

# Production build
pnpm build:all    # macOS arm64 + x64, Windows x64, Linux x64
```

---

## 7. Authentication Flow

### Standard login (no 2FA)

```
Browser                     NestJS API                  Zimbra
  │                              │                          │
  │─ POST /auth/login ──────────▶│                          │
  │  { email, password,          │─ AuthRequest (SOAP) ────▶│
  │    zimbraHost }              │◀─ { authToken, csrfToken,│
  │                              │    lifetime }            │
  │                              │  upsert User record      │
  │                              │  sign JWT (7d)           │
  │◀─ { accessToken, user } ─────│                          │
  │                              │                          │
  │  Store token in localStorage │                          │
  │  (Zustand auth store)        │                          │
```

### 2FA login

```
Browser                         NestJS API               Zimbra
  │─ POST /auth/login ─────────▶│─ AuthRequest ─────────▶│
  │                              │◀─ { twoFactorRequired: │
  │                              │    true, method }       │
  │◀─ { requiresTwoFactor: true, │                         │
  │    twoFactorToken (5m JWT) } │                         │
  │                              │                         │
  │  [user enters TOTP code]     │                         │
  │─ POST /auth/two-factor ─────▶│─ PreAuth + TOTP ──────▶│
  │  { twoFactorToken, code }    │◀─ { authToken, csrf }   │
  │◀─ { accessToken, user } ─────│                         │
```

### JWT details

| Parameter | Value |
|-----------|-------|
| Secret | `JWT_SECRET` env (must be long random in production) |
| Expiry | `JWT_EXPIRES_IN` env, default `7d` |
| Payload | `{ sub: userId, email }` |
| Transport | `Authorization: Bearer {token}` header |
| Storage (web) | `localStorage` via Zustand persist |
| Storage (desktop) | Same localStorage (Electron uses Chromium storage) |

### Session model

Each login upserts a `Session` row tracking `token`, `expiresAt`, `userAgent`, `ipAddress`. The session is invalidated on `/auth/logout`.

---

## 8. Zimbra Integration Layer

`ZimbraService` (`apps/api/src/zimbra/zimbra.service.ts`) is the **only place** in the codebase that communicates with Zimbra. All other services depend on this one.

### SOAP transport

```ts
buildClient(host, authToken, csrfToken): AxiosInstance
```
- Base URL: `https://{zimbraHost}/`
- Cookie: `ZM_AUTH_TOKEN={authToken}`
- Header: `X-Zimbra-Csrf-Token: {csrfToken}` (Zimbra 8.7+)
- All requests POST to `/service/soap` with `{ Body: { ...Request }, Header: { context } }`

### Cluster referral

Some Zimbra deployments respond to `AuthRequest` with a `refer` field containing the actual mailbox server hostname. `ZimbraService.authenticate()` detects this and returns the correct `zimbraHost` to be stored in the `User` record, preventing `AUTH_EXPIRED` errors.

### Method catalogue

| Domain | Methods |
|--------|---------|
| **Auth** | `authenticate`, `verifyTwoFactor` |
| **Folders** | `getFolders`, `createFolder`, `deleteFolder` |
| **Messages** | `getMessages`, `getMessage`, `searchMessages`, `sendMessage`, `moveMessage`, `deleteMessage`, `markRead` |
| **Drafts** | `saveDraft` |
| **Attachments** | `uploadAttachment`, `downloadAttachment` |
| **Contacts** | `getContacts`, `createContact`, `modifyContact`, `deleteContact`, `autoCompleteContacts` |
| **Calendar** | `getCalendarEvents`, `createCalendarEvent`, `modifyCalendarEvent`, `deleteCalendarEvent`, `sendInviteReply`, `getFreeBusy`, `searchGal` |
| **Account** | `getPrefs`, `modifyPrefs`, `getIdentities`, `modifyIdentity`, `getSignatures`, `createSignature`, `modifySignature`, `deleteSignature`, `changePassword` |

### Important: deleteMessage vs discardDraft

`deleteMessage` uses Zimbra's `MsgActionRequest { op: 'trash' }` — it moves to Trash, not permanent deletion. When used for drafts (`discardDraft`), the API also does a `prisma.message.deleteMany` on the local DB to prevent stale records appearing in conversation fetches.

---

## 9. Real-Time Collaboration (Docs)

### Stack

- **CRDT engine:** Yjs (conflict-free — no operational transform, works offline)
- **TipTap v3** with `@tiptap/extension-collaboration` (Yjs binding)
- **WebSocket server:** Hocuspocus v3 (`@hocuspocus/server`) on port 1234
- **Provider (client):** `@hocuspocus/provider` connects TipTap to the server

### Content storage duality

Every `Document` record stores content in two formats:

| Field | Type | Purpose |
|-------|------|---------|
| `content` | `String` (TipTap JSON) | REST consumers — list/share endpoints, initial SSR render |
| `yjsState` | `Bytes` | Yjs binary CRDT state — authoritative for collaborative sessions |

The Hocuspocus `DatabaseExtension` reads `yjsState` on connection and writes it back on disconnect/update. A 500ms debounced REST PATCH also updates `content` for non-collab readers.

### Authentication tokens

```ts
// Token format sent as Hocuspocus connection token:
JSON.stringify({ type: 'jwt' | 'share', value: string })

// JWT auth: user must own the document
// Share auth: document.shareToken must match + document.isShared must be true
```

### Collab flow

```
Browser A                   Hocuspocus (:1234)         Prisma (SQLite)
  │─ WS connect ──────────▶ onAuthenticate              │
  │  { type: 'jwt', value }   → verify JWT              │
  │                            → load yjsState ─────────▶
  │                           ◀─────────────────────────│
  │◀─ initial Yjs doc sync ──│                           │
  │                          │                           │
  │─ edit (Yjs update) ─────▶│─ broadcast to peers       │
  │                          │─ DatabaseExtension ───────▶
  │                          │  store yjsState           │
```

---

## 10. Background Jobs & Schedulers

All schedulers run at `EVERY_MINUTE` via `@nestjs/schedule`. They fire independently and are resilient — errors are logged but do not crash the server.

### Mail Scheduler (`mail/mail.scheduler.ts`)

| Job | Trigger | Action |
|-----|---------|--------|
| `processSnoozed` | Every minute | Finds `SnoozedMessage` where `snoozedUntil <= now`, moves message back to `originalFolderId` via Zimbra `MsgActionRequest { op: 'move' }`, deletes the `SnoozedMessage` row |
| `processScheduled` | Every minute | Finds `ScheduledMessage` where `status=PENDING AND sendAt <= now`, calls `ZimbraService.sendMessage()`, sets `status=SENT` or `status=FAILED` |

### Tasks Scheduler (`tasks/tasks.scheduler.ts`)

| Job | Trigger | Action |
|-----|---------|--------|
| `sendDueReminders` | Every minute | Finds tasks where `reminderAt <= now AND reminderSentAt IS NULL`, sends HTML reminder email via Zimbra, sets `reminderSentAt = now` (prevents re-send) |

### Notification triggers

Notifications are created **inline** in service methods, not by a scheduler:
- `MAIL_SNOOZE_EXPIRED` — created in `MailScheduler.processSnoozed()` for each resurfaced message
- `SCHEDULED_SENT` — created in `MailScheduler.processScheduled()` on successful send
- `TASK_DUE` — created by Tasks Scheduler (future: currently reminder emails only)
- `EVENT_SOON` — reserved type (not yet implemented)

---

## 11. API Endpoint Reference

All routes are prefixed with `/api`. All routes except `/auth/login`, `/auth/two-factor`, and `/docs/shared/:token` require `Authorization: Bearer {JWT}`.

### Auth
| Method | Path | Body / Params | Response |
|--------|------|---------------|----------|
| POST | `/auth/login` | `{ email, password, zimbraHost }` | `{ accessToken, user }` or `{ requiresTwoFactor, twoFactorToken }` |
| POST | `/auth/two-factor` | `{ twoFactorToken, code }` | `{ accessToken, user }` |
| GET | `/auth/me` | — | `{ id, email, displayName }` |
| POST | `/auth/logout` | — | `{ success: true }` |

### Mail
| Method | Path | Notes |
|--------|------|-------|
| GET | `/mail/folders` | Returns folder tree |
| GET | `/mail/folders/:id/messages` | `?limit=50&offset=0` |
| GET | `/mail/messages/:id` | Full message with body + attachments |
| GET | `/mail/messages/:id/conversation` | All messages in thread |
| GET | `/mail/search` | `?q=...&limit=50&offset=0` |
| POST | `/mail/send` | `SendMessageDto` |
| POST | `/mail/send-with-attachments` | `multipart/form-data`, max 10 files |
| POST | `/mail/drafts` | `SaveDraftDto` → `{ zimbraId }` |
| DELETE | `/mail/drafts/:zimbraId` | Trashes in Zimbra + deletes from SQLite |
| DELETE | `/mail/messages/:id` | Moves to Zimbra Trash |
| PATCH | `/mail/messages/:id/read` | `{ read: boolean }` |
| PATCH | `/mail/messages/:id/move` | `{ folderId }` |
| GET | `/mail/messages/:id/attachments/:partId` | Binary response (blob) |
| POST | `/mail/folders` | `{ name }` → creates Zimbra folder |
| DELETE | `/mail/folders/:id` | Deletes Zimbra folder |
| POST | `/mail/snooze` | `{ messageId, snoozedUntil, originalFolderId }` |
| DELETE | `/mail/snooze/:messageId` | Cancels snooze |
| GET | `/mail/snoozed` | All active snoozes for user |
| POST | `/mail/scheduled` | Schedule outbound message |
| DELETE | `/mail/scheduled/:id` | Cancel scheduled message |
| GET | `/mail/scheduled` | All pending scheduled messages |
| GET | `/mail/templates` | |
| POST | `/mail/templates` | |
| PUT | `/mail/templates/:id` | |
| DELETE | `/mail/templates/:id` | |
| GET | `/mail/rules` | |
| POST | `/mail/rules` | |
| PUT | `/mail/rules/:id` | |
| DELETE | `/mail/rules/:id` | |
| POST | `/mail/mute/:conversationId` | Mute a thread |
| DELETE | `/mail/mute/:conversationId` | Unmute |
| GET | `/mail/muted` | |
| POST | `/mail/bulk/mark-read` | `{ messageIds, read }` |
| POST | `/mail/bulk/delete` | `{ messageIds }` |
| POST | `/mail/bulk/move` | `{ messageIds, folderId }` |

### Contacts
| Method | Path | Notes |
|--------|------|-------|
| GET | `/contacts` | `?q=...&sync=false` |
| GET | `/contacts/autocomplete` | `?q=...` |
| POST | `/contacts` | |
| PATCH | `/contacts/:id` | |
| DELETE | `/contacts/:id` | |
| GET | `/contacts/groups` | Distribution groups (local only) |
| POST | `/contacts/groups` | `{ name, description, members }` |
| PATCH | `/contacts/groups/:id` | |
| DELETE | `/contacts/groups/:id` | |

### Calendar
| Method | Path | Notes |
|--------|------|-------|
| GET | `/calendar/events` | `?start=ISO&end=ISO` |
| POST | `/calendar/events` | |
| PATCH | `/calendar/events/:id` | |
| DELETE | `/calendar/events/:id` | |
| POST | `/calendar/events/:id/rsvp` | `{ verb: ACCEPT\|DECLINE\|TENTATIVE }` |
| GET | `/calendar/freebusy` | `?email=...&start=...&end=...` |
| POST | `/calendar/freebusy/batch` | `{ emails[], start, end }` |

### Tasks
| Method | Path | Notes |
|--------|------|-------|
| GET | `/tasks` | `?status=...&linkedMessageId=...` |
| POST | `/tasks` | |
| PATCH | `/tasks/:id` | |
| DELETE | `/tasks/:id` | |
| POST | `/tasks/:id/assign` | `{ assigneeEmail, assigneeName }` |
| POST | `/tasks/:id/subtasks` | |
| PATCH | `/tasks/:id/subtasks/:subId` | |
| DELETE | `/tasks/:id/subtasks/:subId` | |
| POST | `/tasks/:id/comments` | |
| DELETE | `/tasks/:id/comments/:commentId` | |
| POST | `/tasks/:id/attachments` | `multipart/form-data` |
| GET | `/tasks/:id/attachments/:attId/download` | |
| DELETE | `/tasks/:id/attachments/:attId` | |

### Settings
| Method | Path | Notes |
|--------|------|-------|
| GET | `/settings` | Prefs + identities + signatures |
| PATCH | `/settings/prefs` | Zimbra pref key/value map |
| PATCH | `/settings/identity/:id` | |
| POST | `/settings/signatures` | `{ name, contentHtml }` |
| PATCH | `/settings/signatures/:id` | |
| DELETE | `/settings/signatures/:id` | |
| POST | `/settings/password` | `{ oldPassword, newPassword }` |

### Notifications
| Method | Path | Notes |
|--------|------|-------|
| GET | `/notifications` | `?limit=50` |
| GET | `/notifications/unread-count` | `→ { count }` |
| PATCH | `/notifications/:id/read` | |
| PATCH | `/notifications/read-all` | |
| DELETE | `/notifications/:id` | |

### Docs
| Method | Path | Auth |
|--------|------|------|
| GET | `/docs` | JWT |
| POST | `/docs` | JWT |
| GET | `/docs/:id` | JWT |
| PATCH | `/docs/:id` | JWT |
| DELETE | `/docs/:id` | JWT |
| POST | `/docs/:id/share` | JWT — enables sharing, returns `shareToken` |
| DELETE | `/docs/:id/share` | JWT — disables sharing |
| GET | `/docs/shared/:token` | **Public** |
| PATCH | `/docs/shared/:token` | **Public** (collab write) |

---

## 12. Data Flow Diagrams

### Sending an email

```
ComposeModal (web)
  │─ api.mail.send(payload) ──────────────────────▶ POST /mail/send
                                                       │
                                                    MailService.sendMessage()
                                                       │─ ZimbraService.sendMessage()
                                                       │   POST /service/soap
                                                       │   { SendMsgRequest }
                                                       │◀─ { id: sentMessageId }
                                                       │
                                                    (no DB write — Zimbra is source of truth)
                                                       │
                                                    ◀─ { success: true }
```

### Loading a thread

```
ThreadView (web)
  │─ GET /mail/messages/:id/conversation ─────────▶
                                                    MailService.getConversation()
                                                      │─ prisma.message.findMany()
                                                      │   WHERE conversationId = msg.conversationId
                                                      │   ORDER BY receivedAt ASC
                                                      │
                                                    ◀─ { conversationId, messages[] }
```

Note: `getConversation` reads **only from SQLite**. Messages must have been synced (via `getMessages` or `getMessage`) before they appear in a thread. This means the first time a folder is opened, messages populate via `getMessages` which upserts to SQLite.

### Snooze a message

```
SnoozeModal (web)
  │─ api.mail.snooze(messageId, until, folderId) ──▶ POST /mail/snooze
                                                      MailService.snoozeMessage()
                                                        → prisma.snoozedMessage.upsert()
                                                        → ZimbraService.moveMessage(msg, Drafts)
                                                          (hides from inbox during snooze)

[1 minute later — MailScheduler.processSnoozed()]
  MailService.processExpiredSnoozes()
    → prisma.snoozedMessage.findMany(snoozedUntil <= now)
    → ZimbraService.moveMessage(msg, originalFolderId)  (restores to inbox)
    → prisma.snoozedMessage.delete()
    → notificationsService.createNotification(MAIL_SNOOZE_EXPIRED)
```

---

## 13. Environment Variables

### `apps/api/.env`

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `DATABASE_URL` | `file:./dev.db` | No | SQLite file path (`file:` prefix stripped internally) |
| `JWT_SECRET` | `change-this-in-prod` | **Yes** | JWT signing secret — use a long random string in production |
| `JWT_EXPIRES_IN` | `7d` | No | JWT lifetime |
| `FRONTEND_URL` | `http://localhost:3000` | No | CORS allowed origin |
| `PORT` | `3001` | No | API HTTP port |
| `HOCUSPOCUS_PORT` | `1234` | No | Collab WebSocket port |

### `apps/web/.env.local`

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001/api` | No | Backend base URL |
| `NEXT_PUBLIC_USE_MOCK` | `false` | No | Set to `true` to use mock data (no API needed) |
| `NEXT_PUBLIC_COLLAB_WS_URL` | `ws://localhost:1234` | No | Hocuspocus WebSocket URL |

### Desktop overrides (injected at build time)

| Variable | Value |
|----------|-------|
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:3457/api` |
| `NODE_ENV` | `production` |

---

## 14. Key Architectural Decisions

### Decision 1 — SQLite as local cache, not source of truth

Mail/contacts/calendar data is always fetched from Zimbra and written to SQLite via upsert. SQLite is never the source of truth for these — it is a cache that enables:
- Fast conversation threading (no cross-Zimbra SOAP per message)
- Local enrichment (snooze, mute, linked tasks)
- Offline-capable reads in the desktop app

**Implication:** If SQLite data goes stale or corrupt, clearing the DB and letting it resync from Zimbra is always safe for mail/contacts/calendar.

### Decision 2 — Zimbra SOAP over IMAP/REST

Zimbra's SOAP API provides all operations (calendar, GAL, prefs, signatures, identities) that are unavailable over IMAP. The cost is a custom XML/JSON-SOAP client and per-request auth tokens.

### Decision 3 — Better-sqlite3 over Prisma's default driver

Prisma 7 uses a Rust-based query engine by default, which requires native binaries that are hard to ship in Electron. `@prisma/adapter-better-sqlite3` uses the JS `better-sqlite3` package instead — no Rust engine, works in packaged Electron builds. The trade-off is synchronous DB access (better-sqlite3 is blocking).

### Decision 4 — Yjs CRDT for docs, not CRDT + OT

Yjs handles concurrent edits without operational transformation, making offline editing trivial. The cost is binary state that must be stored alongside the JSON representation. Both are kept in sync by the Hocuspocus DB extension.

### Decision 5 — Cross-route drag-and-drop via sessionStorage

Dragging a mail message to Calendar or Tasks is impossible via the browser DragEvent API across page navigations (the page unmounts). The sidebar intercepts the drop, stores the payload in `sessionStorage`, navigates, and the destination page reads it on mount. This is intentional and correct for a Next.js SPA.

### Decision 6 — No GraphQL or tRPC

All endpoints are plain REST JSON. This was chosen to keep the API inspectable via browser devtools and curl, and to allow the Electron bundled API to work with simple `fetch` calls without schema negotiation.

---

## 15. Maintenance Guide

### Adding a new API feature

1. Add the Prisma model to `apps/api/prisma/schema.prisma` if new data is needed
2. Run `cd apps/api && npx prisma migrate dev --name add_<feature>`
3. Run `npx prisma generate`
4. Delete stale TS cache: `rm -f apps/api/dist/tsconfig.tsbuildinfo apps/api/dist/tsconfig.build.tsbuildinfo`
5. Add or extend the NestJS module (service → controller → register in module)
6. Register new module in `apps/api/src/app.module.ts`
7. Add endpoint(s) to `apps/web/lib/api.ts` under the correct namespace
8. Build the UI component and hook it up to the API

### Adding a new frontend page

1. Create `apps/web/app/(app)/<page>/page.tsx`
2. Add a nav item to `apps/web/components/layout/Sidebar.tsx`
3. Add the hydration/auth guard pattern (check `useAuthStore().isAuthenticated`)
4. Add `api.<namespace>` methods to `lib/api.ts`

### Updating the Prisma schema (critical path)

```bash
# 1. Edit schema.prisma
# 2. Create and apply migration
cd apps/api && npx prisma migrate dev --name <descriptive_name>
# 3. Regenerate client
npx prisma generate
# 4. Clear stale TS cache (required after schema changes)
rm -f dist/tsconfig.tsbuildinfo dist/tsconfig.build.tsbuildinfo
# 5. Verify no TS errors
npx tsc --noEmit
```

### Running the full stack locally

```bash
# Terminal 1 — API
cd apps/api && pnpm dev

# Terminal 2 — Web
cd apps/web && pnpm dev

# Optional — Desktop (only if testing Electron)
cd apps/desktop && pnpm dev
```

### Mock mode (UI development without a Zimbra server)

```bash
# apps/web/.env.local
NEXT_PUBLIC_USE_MOCK=true
```

All `api.*` calls return fixtures from `lib/mock-data.ts`. The auth store is pre-seeded with `MOCK_USER`. Useful for UI-only feature work.

### Debugging Zimbra SOAP issues

All Zimbra calls go through `ZimbraService`. Add `console.log` there or enable Axios request logging:
- Watch for `AUTH_EXPIRED` → user's Zimbra auth token has expired; user must re-login
- Watch for `refer` in `AuthResponse` → cluster redirect; must store the new `zimbraHost`
- CSRF errors → token mismatch; check `X-Zimbra-Csrf-Token` header on mutating requests

### Collab/WebSocket debugging

- The Hocuspocus server starts in `main.ts` alongside Express — check console for `Hocuspocus: Listening on port 1234`
- Token format must be `JSON.stringify({ type: 'jwt'|'share', value: '...' })` — plain string tokens will fail auth
- `yjsState` is binary — do not try to JSON-parse or log it directly

---

*This document was generated from a full codebase analysis and should be kept updated when major features are added or the system architecture changes.*
