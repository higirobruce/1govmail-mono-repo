# Exchange Phase 1 — Provider Abstraction + Institution Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a provider-neutral `MailProvider` layer from `ZimbraService` and switch login to institution-driven server-side provider/host resolution — zero behavior change for Zimbra users.

**Architecture:** A `MailProvider` interface + neutral DTOs replace direct `ZimbraService` coupling; a `MailSession` object replaces the `(host, authToken, csrfToken?)` triplet; an `Institution` DB table maps the login dropdown to provider/host/NTLM-domain server-side; a `MailProviderResolver` picks the implementation per user. `ZimbraService` becomes the sole (for now) implementation.

**Tech Stack:** NestJS 11, Prisma 7 (PostgreSQL), Jest (api), Next.js 16 + Vitest (web).

**Spec:** `docs/superpowers/specs/2026-09-09-exchange-ews-design.md` (§3, §6, §8; §7 capabilities plumbing lands here with all-true values)

## Global Constraints

- Zimbra behavior must not change: same SOAP requests, same REST API responses (except `GET /settings` gaining a `capabilities` object and `GET /auth/institutions` being new).
- Do **not** rename existing `User` columns (`zimbraHost`, `authToken`, `csrfToken`, `tokenExpiry`).
- After any Prisma schema change: `cd apps/api && npx prisma migrate dev --name <name> && npx prisma generate`, then `rm -f dist/tsconfig.tsbuildinfo dist/tsconfig.build.tsbuildinfo`.
- Every task ends with `npx tsc --noEmit` clean in `apps/api` (and `apps/web` when web files change) and the touched test suite green (`npx jest <path>` / `npx vitest run <path>`).
- Never log passwords or tokens. No `rejectUnauthorized: false` anywhere.
- Work on `ft-hyperscale`; one commit per task.
- The MINAFFET test-account passwords appear nowhere in the repo.

---

### Task 1: Institution table + User.provider migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<ts>_add_provider_institutions/migration.sql` (hand-authored)

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `Institution` and new `User` fields `provider` / `institutionId` used by Tasks 2, 3, 10.

- [ ] **Step 1: Add models to `schema.prisma`**

In the `User` model add (keep every existing field untouched):

```prisma
  /// Mail backend for this account: 'zimbra' | 'ews' | 'memory'
  provider      String  @default("zimbra")
  institutionId String?
```

Add the new model (top level). Note: `zimbraHost` now means "mail server host" generally — add that as a comment on the existing field, do not rename it:

```prisma
/// Login-time mapping: institution -> mail backend. Seeded by migration;
/// host/provider never come from the client.
model Institution {
  id        String  @id
  label     String
  provider  String
  host      String
  ewsDomain String?
  enabled   Boolean @default(true)
  position  Int     @default(0)

  @@map("institutions")
}
```

- [ ] **Step 2: Create the migration (hand-authored, includes seed)**

Run `npx prisma migrate dev --name add_provider_institutions --create-only` from `apps/api`, then replace the generated SQL with:

```sql
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
```

- [ ] **Step 3: Apply and regenerate**

Run from `apps/api`: `npx prisma migrate dev && npx prisma generate && rm -f dist/tsconfig.tsbuildinfo dist/tsconfig.build.tsbuildinfo`
Expected: migration applied, client regenerated.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit` (in `apps/api`). Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma
git commit -m "feat(api): Institution registry table + User.provider (Exchange phase 1)"
```

---

### Task 2: InstitutionRegistry service + GET /auth/institutions

**Files:**
- Create: `apps/api/src/auth/institution.registry.ts`
- Create: `apps/api/src/auth/institution.registry.spec.ts`
- Modify: `apps/api/src/auth/auth.controller.ts` (add endpoint), `apps/api/src/auth/auth.module.ts` (provide/export registry)

**Interfaces:**
- Consumes: Prisma `Institution` model (Task 1).
- Produces: `InstitutionRegistry.list(): Promise<Array<{id: string; label: string}>>`, `InstitutionRegistry.resolve(id: string): Promise<Institution | null>`, `InstitutionRegistry.resolveByHost(host: string): Promise<Institution | null>` — used by Tasks 3 and 10.

- [ ] **Step 1: Write the failing test**

`institution.registry.spec.ts` (mirror the repo's existing NestJS spec pattern — mocked `PrismaService`):

```ts
import { Test } from '@nestjs/testing';
import { InstitutionRegistry } from './institution.registry';
import { PrismaService } from '../prisma/prisma.service';

const rows = [
  { id: 'risa', label: 'RISA', provider: 'zimbra', host: 'mail.risa.gov.rw:8443', ewsDomain: null, enabled: true, position: 0 },
  { id: 'minaffet', label: 'MINAFFET', provider: 'ews', host: 'webmail.minaffet.gov.rw', ewsDomain: 'MINAFFET', enabled: true, position: 2 },
];

describe('InstitutionRegistry', () => {
  let registry: InstitutionRegistry;
  const prisma = {
    institution: {
      findMany: jest.fn(async () => rows),
      findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null),
      findFirst: jest.fn(async ({ where }: any) => rows.find((r) => r.host === where.host && r.enabled) ?? null),
    },
  };

  beforeEach(async () => {
    delete process.env.MAIL_PROVIDER_MEMORY;
    const mod = await Test.createTestingModule({
      providers: [InstitutionRegistry, { provide: PrismaService, useValue: prisma }],
    }).compile();
    registry = mod.get(InstitutionRegistry);
  });

  it('lists enabled institutions as id+label only, ordered by position', async () => {
    const list = await registry.list();
    expect(list).toEqual([
      { id: 'risa', label: 'RISA' },
      { id: 'minaffet', label: 'MINAFFET' },
    ]);
    expect(prisma.institution.findMany).toHaveBeenCalledWith({
      where: { enabled: true },
      orderBy: { position: 'asc' },
    });
  });

  it('appends the demo entry only when MAIL_PROVIDER_MEMORY=true', async () => {
    process.env.MAIL_PROVIDER_MEMORY = 'true';
    const list = await registry.list();
    expect(list[list.length - 1]).toEqual({ id: 'memory', label: 'Demo (local)' });
  });

  it('resolve returns the full row, or the synthetic memory row when enabled', async () => {
    expect((await registry.resolve('minaffet'))?.ewsDomain).toBe('MINAFFET');
    expect(await registry.resolve('memory')).toBeNull();
    process.env.MAIL_PROVIDER_MEMORY = 'true';
    expect((await registry.resolve('memory'))?.provider).toBe('memory');
  });

  it('resolveByHost matches the legacy zimbraHost field', async () => {
    expect((await registry.resolveByHost('mail.risa.gov.rw:8443'))?.id).toBe('risa');
    expect(await registry.resolveByHost('evil.example.com')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/auth/institution.registry.spec.ts` (in `apps/api`)
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `institution.registry.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { Institution } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MEMORY_ROW: Institution = {
  id: 'memory', label: 'Demo (local)', provider: 'memory',
  host: 'memory.local', ewsDomain: null, enabled: true, position: 9999,
};

@Injectable()
export class InstitutionRegistry {
  constructor(private readonly prisma: PrismaService) {}

  private memoryEnabled(): boolean {
    return process.env.MAIL_PROVIDER_MEMORY === 'true';
  }

  /** Login dropdown payload — never exposes provider/host. */
  async list(): Promise<Array<{ id: string; label: string }>> {
    const rows = await this.prisma.institution.findMany({
      where: { enabled: true },
      orderBy: { position: 'asc' },
    });
    const out = rows.map((r) => ({ id: r.id, label: r.label }));
    if (this.memoryEnabled()) out.push({ id: MEMORY_ROW.id, label: MEMORY_ROW.label });
    return out;
  }

  async resolve(id: string): Promise<Institution | null> {
    if (id === 'memory') return this.memoryEnabled() ? MEMORY_ROW : null;
    const row = await this.prisma.institution.findUnique({ where: { id } });
    return row?.enabled ? row : null;
  }

  /** Legacy support: map a client-supplied host back to its institution. */
  async resolveByHost(host: string): Promise<Institution | null> {
    return this.prisma.institution.findFirst({ where: { host, enabled: true } });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/auth/institution.registry.spec.ts` — Expected: PASS.

- [ ] **Step 5: Endpoint + module wiring**

In `auth.module.ts` add `InstitutionRegistry` to `providers` and `exports`. In `auth.controller.ts` add (public route — match how `login` is exempted from the JWT guard in this controller, e.g. the same `@Public()` decorator or guard-free placement):

```ts
@Get('institutions')
async institutions() {
  return this.institutionRegistry.list();
}
```

(constructor gains `private readonly institutionRegistry: InstitutionRegistry`).

- [ ] **Step 6: Full auth suite + typecheck**

Run: `npx jest src/auth && npx tsc --noEmit` — Expected: PASS/clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth
git commit -m "feat(api): GET /auth/institutions backed by InstitutionRegistry"
```

---

### Task 3: Institution-driven login

**Files:**
- Modify: `apps/api/src/auth/dto/login.dto.ts` (or the DTO file `login` uses — locate with `grep -rn "zimbraHost" apps/api/src/auth`), `apps/api/src/auth/auth.service.ts`
- Test: extend `apps/api/src/auth/auth.service.spec.ts`

**Interfaces:**
- Consumes: `InstitutionRegistry.resolve/resolveByHost` (Task 2).
- Produces: `POST /auth/login` accepting `{ institution?: string; zimbraHost?: string; email; password }`; `User` upserts now set `provider` + `institutionId`. Task 4's frontend sends `institution`.

- [ ] **Step 1: Write the failing tests** (extend the existing auth.service spec, reusing its mock setup; add an `InstitutionRegistry` mock provider that resolves like Task 2's rows)

```ts
it('login resolves institution server-side and stamps provider + institutionId', async () => {
  const res = await service.login({ institution: 'risa', email: 'u@risa.gov.rw', password: 'pw' } as any);
  expect(zimbra.authenticate).toHaveBeenCalledWith('mail.risa.gov.rw:8443', 'u@risa.gov.rw', 'pw');
  expect(prisma.user.upsert).toHaveBeenCalledWith(expect.objectContaining({
    create: expect.objectContaining({ provider: 'zimbra', institutionId: 'risa' }),
    update: expect.objectContaining({ provider: 'zimbra', institutionId: 'risa' }),
  }));
  expect(res).toHaveProperty('accessToken');
});

it('rejects unknown or disabled institutions with 400', async () => {
  await expect(service.login({ institution: 'nope', email: 'a@b', password: 'x' } as any))
    .rejects.toThrow(BadRequestException);
});

it('legacy zimbraHost still works when it matches a registry row', async () => {
  await service.login({ zimbraHost: 'mail.risa.gov.rw:8443', email: 'u@risa.gov.rw', password: 'pw' } as any);
  expect(zimbra.authenticate).toHaveBeenCalledWith('mail.risa.gov.rw:8443', 'u@risa.gov.rw', 'pw');
});

it('rejects a zimbraHost not present in the registry', async () => {
  await expect(service.login({ zimbraHost: 'evil.example.com', email: 'a@b', password: 'x' } as any))
    .rejects.toThrow(BadRequestException);
});

it('rejects ews/memory institutions until their providers exist', async () => {
  await expect(service.login({ institution: 'minaffet', email: 'a@minaffet.gov.rw', password: 'x' } as any))
    .rejects.toThrow(BadRequestException); // "not yet supported" — lifted in Phase 2/3
});
```

- [ ] **Step 2: Run to verify failure** — `npx jest src/auth/auth.service.spec.ts` → FAIL.

- [ ] **Step 3: Implement**

`login.dto.ts`: add `@IsOptional() @IsString() institution?: string;` keep `zimbraHost` but make it `@IsOptional()`. At least one of the two must be present — validate in the service.

`auth.service.ts`, at the top of `login()` before any Zimbra call:

```ts
const inst = dto.institution
  ? await this.institutionRegistry.resolve(dto.institution)
  : dto.zimbraHost
    ? await this.institutionRegistry.resolveByHost(dto.zimbraHost)
    : null;
if (!inst) {
  throw new BadRequestException('Unknown institution. Pick your institution from the list.');
}
if (dto.zimbraHost && !dto.institution) {
  this.logger.warn(`Legacy zimbraHost login for ${inst.id} — client should send institution`);
}
if (inst.provider !== 'zimbra') {
  // Lifted when the ews/memory providers land (Phase 2/3).
  throw new BadRequestException(`${inst.label} sign-in is not yet supported on this server.`);
}
const host = inst.host;
```

Use `host` for the existing `zimbraService.authenticate(...)` call, and add `provider: inst.provider, institutionId: inst.id` to both `create` and `update` of the user upsert. Everything else (2FA, JWT, Session row) is untouched.

- [ ] **Step 4: Run to verify pass** — `npx jest src/auth && npx tsc --noEmit` → PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth
git commit -m "feat(api): institution-driven login — server resolves provider/host"
```

---

### Task 4: Web login — institution picker only

**Files:**
- Modify: `apps/web/lib/api.ts` (auth namespace), `apps/web/app/(auth)/login/page.tsx`, `apps/web/stores/auth.store.ts` (only if `login()` signature threads the host — check with `grep -n "zimbraHost" apps/web/stores/auth.store.ts`)
- Test: create `apps/web/app/(auth)/login/institutions.test.ts` (pure helper test)

**Interfaces:**
- Consumes: `GET /auth/institutions`, login body `{institution,email,password}` (Tasks 2–3).
- Produces: nothing downstream.

- [ ] **Step 1: `lib/api.ts`** — in the `auth` namespace add `institutions: () => request<Array<{id:string;label:string}>>('/auth/institutions')` (match the file's existing request helper style), and change `login` to accept and send `institution` instead of `zimbraHost` (keep the field name `zimbraHost` out of the payload entirely).

- [ ] **Step 2: Login page** — delete the hardcoded `INSTITUTIONS` array. On mount, fetch `api.auth.institutions()` into state (loading → disabled select; error → inline "Could not load institutions — retry" button, no crash). The `<select>` renders `{label}` options keyed by `id`; form state stores the selected `id` (default: first entry); submit calls `login(form.email, form.password, form.institution)` — update `auth.store`'s `login` signature accordingly (rename its `zimbraHost` param to `institution`, pass through to `api.auth.login`).

- [ ] **Step 3: Failing test for the fetch-shape helper** — extract the dropdown-state logic worth testing into `institutions.ts` next to the page:

```ts
export type InstitutionOption = { id: string; label: string };
export function institutionsToOptions(rows: InstitutionOption[]): InstitutionOption[] {
  // Defensive: API already filters/orders; drop malformed rows so the form never renders blanks.
  return rows.filter((r) => r && typeof r.id === 'string' && r.id && typeof r.label === 'string' && r.label);
}
```

Test (`institutions.test.ts`): malformed rows dropped, valid preserved in order. Run `npx vitest run app/\(auth\)/login` → FAIL first, then implement → PASS.

- [ ] **Step 4: Full web gates** — `npx vitest run && npx tsc --noEmit` (in `apps/web`) → PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): login selects institution only; server resolves mail backend"
```

---

### Task 5: Provider scaffolding — MailSession, neutral DTOs, MailProvider interface

**Files:**
- Create: `apps/api/src/provider/mail-session.ts`, `apps/api/src/provider/provider-types.ts`, `apps/api/src/provider/mail-provider.interface.ts`, `apps/api/src/provider/capability.error.ts`
- Test: `apps/api/src/provider/mail-session.spec.ts`

**Interfaces:**
- Consumes: `User` row shape (Prisma).
- Produces: everything Tasks 6–10 code against. **The signatures below are the contract — later tasks must match them exactly.**

- [ ] **Step 1: `mail-session.ts` + failing test**

```ts
import { User } from '@prisma/client';

export interface MailSession {
  host: string;
  email: string;
  /** Zimbra: server-issued token. EWS (later): encrypted credentials live here too. */
  authToken?: string;
  csrfToken?: string;
  /** EWS only (Phase 3): decrypted per request by this helper. */
  credentials?: { username: string; password: string };
}

/** The ONLY place User columns map to a provider session. */
export function buildMailSession(user: Pick<User, 'zimbraHost' | 'email' | 'authToken' | 'csrfToken' | 'provider'>): MailSession {
  return {
    host: user.zimbraHost,
    email: user.email,
    authToken: user.authToken ?? undefined,
    csrfToken: user.csrfToken ?? undefined,
  };
}
```

Test (`mail-session.spec.ts`): builds from a user row; `null` token/csrf become `undefined`. Run → FAIL → implement → PASS.

- [ ] **Step 2: `provider-types.ts`** — neutral DTOs. Derive exact fields from what `MailService`/`ContactsService`/`CalendarService` actually consume today (grep their parsing of `ZimbraMessage`/`ZimbraFolder`/contact/event shapes and union the fields). Starting definition — extend during Tasks 6–8 as the mappers reveal consumed fields, never shrink:

```ts
export interface ProviderFolder {
  id: string; name: string; path: string;
  type?: string;                 // inbox|sent|drafts|trash|junk|custom
  unreadCount: number; totalCount: number;
  parentId?: string;
}

export interface ProviderAddress { email: string; name?: string }

export interface ProviderAttachmentMeta {
  part: string; filename: string; contentType: string; size: number;
  isInline: boolean; contentId?: string;
}

export interface ProviderMessage {
  id: string; conversationId: string | null; folderId: string;
  subject: string | null; snippet: string | null;
  from: ProviderAddress; to: ProviderAddress[]; cc: ProviderAddress[]; bcc: ProviderAddress[];
  receivedAt: Date; size: number;
  isRead: boolean; isFlagged: boolean; hasAttachments: boolean;
  tags: string[];
  bodyHtml?: string | null; bodyText?: string | null;
  attachments?: ProviderAttachmentMeta[];
}

export interface ProviderMessagePage { messages: ProviderMessage[]; total: number; more: boolean }

export interface ProviderContact {
  id: string; displayName: string | null;
  firstName?: string; lastName?: string;
  emails: string[]; phones: string[]; company?: string;
}

export interface ProviderEventAttendee extends ProviderAddress { ptst?: string }

export interface ProviderEvent {
  id: string; title: string; location?: string;
  startAt: Date; endAt: Date; allDay: boolean;
  description?: string;
  organizer?: ProviderAddress; attendees: ProviderEventAttendee[];
  // extend with the fields calendar.service actually reads (recurrence, ptst, apptId…) during Task 8
}

export interface ProviderFreeBusy {
  busy: Array<{ s: number; e: number }>;
  tentative: Array<{ s: number; e: number }>;
  unavailable: Array<{ s: number; e: number }>;
}

export interface ProviderAuthResult {
  authToken?: string; csrfToken?: string; displayName?: string;
  twoFactorRequired: boolean;
}

export interface MailProviderCapabilities {
  signatures: boolean; identities: boolean; serverPrefs: boolean;
  changePassword: boolean; twoFactor: boolean;
}
```

- [ ] **Step 3: `capability.error.ts`**

```ts
export class CapabilityNotSupportedError extends Error {
  constructor(capability: string) {
    super(`This mail server does not support ${capability}.`);
    this.name = 'CapabilityNotSupportedError';
  }
}
```

- [ ] **Step 4: `mail-provider.interface.ts`** — the complete catalogue. Session-first everywhere; payload shapes copied from today's ZimbraService params:

```ts
import { MailSession } from './mail-session';
import {
  ProviderFolder, ProviderMessage, ProviderMessagePage, ProviderContact,
  ProviderEvent, ProviderEventAttendee, ProviderFreeBusy, ProviderAuthResult,
  MailProviderCapabilities, ProviderAddress,
} from './provider-types';

export interface SendMessagePayload {
  to: string[]; cc?: string[]; bcc?: string[];
  subject: string; body: string;
  replyToId?: string; replyType?: 'r' | 'w';
}

export interface DraftPayload { id?: string; to?: string[]; cc?: string[]; bcc?: string[]; subject?: string; body?: string }

export interface CalendarEventPayload {
  title: string; location?: string; startAt: Date; endAt: Date; allDay: boolean;
  description?: string; organizerEmail: string; organizerName?: string; attendees?: string[];
}

export interface MailProvider {
  readonly name: 'zimbra' | 'ews' | 'memory';
  readonly capabilities: MailProviderCapabilities;

  // auth
  authenticate(host: string, email: string, password: string): Promise<ProviderAuthResult>;
  verifyTwoFactor(host: string, email: string, code: string, tempToken: string): Promise<ProviderAuthResult>;

  // folders
  getFolders(s: MailSession): Promise<ProviderFolder[]>;
  createFolder(s: MailSession, name: string, parentId?: string): Promise<ProviderFolder>;
  deleteFolder(s: MailSession, folderId: string): Promise<void>;
  renameFolder(s: MailSession, folderId: string, name: string): Promise<void>;
  emptyFolder(s: MailSession, folderId: string): Promise<void>;

  // messages
  getMessages(s: MailSession, folderId: string, limit?: number, offset?: number): Promise<ProviderMessagePage>;
  getMessage(s: MailSession, messageId: string): Promise<ProviderMessage>;
  searchMessages(s: MailSession, query: string, limit?: number, offset?: number): Promise<ProviderMessagePage>;
  sendMessage(
    s: MailSession, payload: SendMessagePayload,
    attachmentAids?: string[],
    inlineImageAids?: Array<{ aid: string; cid: string; ct: string }>,
    forwardedAttachments?: Array<{ mid: string; part: string }>,
  ): Promise<{ id: string; conversationId: string | null }>;
  saveDraft(s: MailSession, payload: DraftPayload): Promise<string>;
  deleteMessage(s: MailSession, messageId: string): Promise<void>;
  markRead(s: MailSession, messageId: string, read: boolean): Promise<void>;
  moveMessage(s: MailSession, messageId: string, folderId: string): Promise<void>;

  // attachments (Zimbra pre-upload `aid` model today; §5.3 of the spec flags
  // this for generalization to buffers when EWS lands — keep the method
  // signatures matching current call sites for zero behavior change now)
  uploadAttachment(s: MailSession, filename: string, contentType: string, data: Buffer): Promise<string>;
  downloadAttachment(s: MailSession, messageId: string, part: string): Promise<{ data: Buffer; contentType: string; filename: string }>;
  downloadAttachmentBuffer(s: MailSession, messageId: string, part: string): Promise<Buffer>;

  // contacts + GAL
  getContacts(s: MailSession, limit?: number, offset?: number): Promise<ProviderContact[]>;
  createContact(s: MailSession, contact: Partial<ProviderContact>): Promise<ProviderContact>;
  modifyContact(s: MailSession, id: string, contact: Partial<ProviderContact>): Promise<void>;
  deleteContact(s: MailSession, id: string): Promise<void>;
  autoCompleteContacts(s: MailSession, query: string): Promise<Array<{ email: string; display: string }>>;
  searchGal(s: MailSession, query: string): Promise<Array<{ email: string; display: string }>>;

  // calendar
  getCalendarEvents(s: MailSession, startMs: number, endMs: number): Promise<ProviderEvent[]>;
  getAppointment(s: MailSession, id: string): Promise<ProviderEvent & { attendees: ProviderEventAttendee[] }>;
  createCalendarEvent(s: MailSession, payload: CalendarEventPayload): Promise<string>;
  modifyCalendarEvent(s: MailSession, id: string, payload: Partial<CalendarEventPayload>): Promise<void>;
  deleteCalendarEvent(s: MailSession, id: string): Promise<void>;
  sendInviteReply(s: MailSession, inviteId: string, verb: 'ACCEPT' | 'DECLINE' | 'TENTATIVE'): Promise<void>;
  getFreeBusy(s: MailSession, email: string, startMs: number, endMs: number): Promise<ProviderFreeBusy>;

  // settings-surface (capability-gated; EWS throws CapabilityNotSupportedError)
  getPrefs(s: MailSession): Promise<Record<string, string>>;
  modifyPrefs(s: MailSession, prefs: Record<string, string>): Promise<void>;
  getIdentities(s: MailSession): Promise<unknown[]>;
  modifyIdentity(s: MailSession, id: string, attrs: Record<string, unknown>): Promise<void>;
  getSignatures(s: MailSession): Promise<unknown[]>;
  createSignature(s: MailSession, name: string, contentHtml: string): Promise<string>;
  modifySignature(s: MailSession, id: string, name: string, contentHtml: string): Promise<void>;
  deleteSignature(s: MailSession, id: string): Promise<void>;
  changePassword(s: MailSession, oldPassword: string, newPassword: string): Promise<void>;
}
```

**Adjustment rule (this is part of the contract):** where a signature above disagrees with what a real call site needs (e.g. an extra param, identity/signature shapes, `galSelfLookup`), adjust the *interface* during Tasks 6–9 to match reality — never bend a call site to the plan. `downloadZimbraPath` and `galSelfLookup` are Zimbra-specific and stay OFF the interface as `ZimbraService` extras; their callers (`common/signature-images.ts`, settings suggestions) keep using `ZimbraService` directly via the resolver's `zimbra` instance and must degrade gracefully for non-zimbra users (skip the enrichment).

- [ ] **Step 5: Gates + commit**

`npx jest src/provider && npx tsc --noEmit` → PASS/clean.

```bash
git add apps/api/src/provider
git commit -m "feat(api): MailProvider interface, MailSession, neutral provider DTOs"
```

---

### Task 6: Zimbra provider — mail domain onto MailSession + neutral DTOs

**Files:**
- Modify: `apps/api/src/zimbra/zimbra.service.ts` (mail-domain methods), `apps/api/src/mail/mail.service.ts`, plus every other caller of these methods (`tasks/tasks.scheduler.ts`, `tasks/tasks.service.ts`, `docs/docs.service.ts`, `common/signature-images.ts` — find all with `grep -rn "getMessages\|getMessage(\|searchMessages\|sendMessage\|saveDraft\|markRead\|moveMessage\|deleteMessage\|getFolders\|uploadAttachment\|downloadAttachment" apps/api/src --include="*.ts" -l`)
- Create: `apps/api/src/zimbra/zimbra.mappers.ts`
- Test: `apps/api/src/zimbra/zimbra.mappers.spec.ts`; existing suites must stay green.

**Interfaces:**
- Consumes: `MailSession`, `ProviderMessage`/`ProviderFolder`/`ProviderMessagePage` and the Task 5 signatures (folders + messages + attachments sections) — implement those signatures **exactly**.
- Produces: `ZimbraService` mail-domain methods in provider shape; `mapZimbraMessage(raw: ZimbraMessage): ProviderMessage`, `mapZimbraFolder(raw: ZimbraFolder): ProviderFolder` exported from `zimbra.mappers.ts`.

**Method list for this task (all converted in one pass, callers updated in the same commit):** `getFolders, createFolder, deleteFolder, renameFolder, emptyFolder, getMessages, getMessage, searchMessages, sendMessage, saveDraft, deleteMessage, markRead, moveMessage, uploadAttachment, downloadAttachment, downloadAttachmentBuffer`. (`downloadZimbraPath` keeps its current signature — Zimbra extra.)

- [ ] **Step 1: Write failing mapper tests** — move the wire→app parsing that `MailService` does today into `zimbra.mappers.ts`, and pin it with fixtures lifted from the current code's expectations:

```ts
import { mapZimbraMessage, mapZimbraFolder } from './zimbra.mappers';

const rawMsg = {
  id: '257', cid: '-257', l: '2', su: 'Budget review', fr: 'Please find attached…',
  d: 1757404800000, s: 4096, f: 'ua',
  e: [
    { t: 'f', a: 'alice@risa.gov.rw', p: 'Alice' },
    { t: 't', a: 'me@risa.gov.rw' },
  ],
  mp: [{ ct: 'multipart/mixed', mp: [{ part: '2', ct: 'application/pdf', filename: 'ToR.pdf', s: 1000, cd: 'attachment' }] }],
  tn: 'NeedsDecision',
} as any;

it('maps a Zimbra search hit to ProviderMessage', () => {
  const m = mapZimbraMessage(rawMsg);
  expect(m).toMatchObject({
    id: '257', conversationId: '-257', folderId: '2',
    subject: 'Budget review', snippet: 'Please find attached…',
    from: { email: 'alice@risa.gov.rw', name: 'Alice' },
    isRead: false,       // 'u' flag present = unread
    isFlagged: false,
    hasAttachments: true,
    tags: ['NeedsDecision'],
  });
  expect(m.receivedAt).toEqual(new Date(1757404800000));
});

it('maps folders with unread/total counts and system paths', () => {
  const f = mapZimbraFolder({ id: '2', name: 'Inbox', absFolderPath: '/Inbox', u: 3, n: 40 } as any);
  expect(f).toMatchObject({ id: '2', name: 'Inbox', path: '/Inbox', unreadCount: 3, totalCount: 40 });
});
```

**Before writing the mappers, read the real parsing in `mail.service.ts`** (flag semantics `u`/`f`/`a` in the `f` field, address `t:` roles, `mp` attachment walking, tag names `tn`) and replicate it exactly — the fixtures above must match what `MailService` produces today, byte for byte where it reaches the REST API. Adjust the fixture expectations to the code's actual semantics if they differ; the code is authoritative.

- [ ] **Step 2: Run to verify failure** — `npx jest src/zimbra/zimbra.mappers.spec.ts` → FAIL.

- [ ] **Step 3: Implement mappers, convert signatures, hoist parsing**

For each listed method: change `(host, authToken, X, csrfToken?)` → `(s: MailSession, X)`; first line `const client = this.buildClient(s.host, s.authToken, s.csrfToken);`; where the old code returned `ZimbraMessage`/raw shapes, apply the mapper before returning. Example — `getMessages` after conversion:

```ts
async getMessages(s: MailSession, folderId: string, limit = 50, offset = 0): Promise<ProviderMessagePage> {
  const client = this.buildClient(s.host, s.authToken, s.csrfToken);
  try {
    const response = await client.post('/service/soap', {
      Body: {
        SearchRequest: {
          _jsns: 'urn:zimbraMail',
          types: 'message',
          query: `inid:${folderId}`,
          // …unchanged SOAP body…
        },
      },
      Header: this.soapHeader(s.csrfToken),
    });
    const raw = response.data?.Body?.SearchResponse;
    return {
      messages: (raw?.m ?? []).map(mapZimbraMessage),
      total: raw?.total ?? 0,
      more: !!raw?.more,
    };
  } catch (e) { this.handleZimbraError(e); }
}
```

In `MailService` (and the other callers), replace triplet threading with `const session = buildMailSession(user);` and delete the now-hoisted parsing — the service consumes `ProviderMessage` fields directly. Keep the REST response shapes identical (rename-in-place: where the controller returned parsed fields, they now come pre-parsed).

- [ ] **Step 4: Gates** — `npx jest src/zimbra src/mail src/tasks src/docs && npx tsc --noEmit` → PASS/clean. Then the FULL api suite: `npx jest` → PASS (this task touches wide surface).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "refactor(api): Zimbra mail domain speaks MailSession + neutral DTOs"
```

---

### Task 7: Zimbra provider — contacts + GAL domain

**Files:**
- Modify: `apps/api/src/zimbra/zimbra.service.ts` (contact methods), `apps/api/src/contacts/contacts.service.ts`, `apps/api/src/settings/settings.service.ts` (GAL suggestion path), any other caller (`grep -rn "getContacts\|createContact\|modifyContact\|deleteContact\|autoCompleteContacts\|searchGal\|galSelfLookup" apps/api/src --include="*.ts" -l | grep -v zimbra/`)
- Modify: `apps/api/src/zimbra/zimbra.mappers.ts` (+spec) — add `mapZimbraContact`

**Interfaces:**
- Consumes: Task 5 signatures (contacts + GAL section), `ProviderContact`.
- Produces: contact methods in provider shape; `mapZimbraContact(raw): ProviderContact`.

**Method list:** `getContacts, createContact, modifyContact, deleteContact, autoCompleteContacts, searchGal` (interface) + `galSelfLookup` (Zimbra extra — session param only, stays off the interface).

- [ ] **Step 1: Failing mapper test** — add to `zimbra.mappers.spec.ts`:

```ts
it('maps a Zimbra contact to ProviderContact', () => {
  const c = mapZimbraContact({ id: '310', _attrs: {
    firstName: 'Alice', lastName: 'Umutoni', fullName: 'Alice Umutoni',
    email: 'alice@risa.gov.rw', email2: 'a.umutoni@gmail.com',
    mobilePhone: '+250788111222', company: 'RISA',
  }} as any);
  expect(c).toMatchObject({
    id: '310', displayName: 'Alice Umutoni', firstName: 'Alice', lastName: 'Umutoni',
    emails: ['alice@risa.gov.rw', 'a.umutoni@gmail.com'],
    phones: ['+250788111222'], company: 'RISA',
  });
});
```

(As in Task 6: read `contacts.service.ts`'s current `_attrs` handling first and make the mapper replicate it exactly; fix the fixture to reality if it differs.)

- [ ] **Step 2: Run → FAIL**, implement mapper, convert the listed methods to `(s: MailSession, …)`, hoist parsing out of `contacts.service.ts`, update the settings GAL-suggestion call site (`galSelfLookup(s)`).

- [ ] **Step 3: Gates** — `npx jest src/zimbra src/contacts src/settings && npx tsc --noEmit` → PASS/clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src
git commit -m "refactor(api): Zimbra contacts/GAL domain speaks MailSession + neutral DTOs"
```

---

### Task 8: Zimbra provider — calendar domain

**Files:**
- Modify: `apps/api/src/zimbra/zimbra.service.ts` (calendar methods), `apps/api/src/calendar/calendar.service.ts`, other callers (`grep -rn "getCalendarEvents\|getAppointment\|createCalendarEvent\|modifyCalendarEvent\|deleteCalendarEvent\|sendInviteReply\|getFreeBusy" apps/api/src --include="*.ts" -l | grep -v zimbra/` — expect `chat/meeting-prep.service.ts` and agent tools among them)
- Modify: `apps/api/src/zimbra/zimbra.mappers.ts` (+spec) — add `mapZimbraAppointment`

**Interfaces:**
- Consumes: Task 5 signatures (calendar section), `ProviderEvent`, `ProviderFreeBusy`.
- Produces: calendar methods in provider shape; `mapZimbraAppointment(raw): ProviderEvent`. Extend `ProviderEvent` in `provider-types.ts` with whatever fields `calendar.service.ts` actually consumes (recurrence, invite/appt ids, per-attendee `ptst`) — additive only.

- [ ] **Step 1: Failing mapper test** — add to `zimbra.mappers.spec.ts`. Starting fixture below; **first read `calendar.service.ts`'s actual appointment parsing** and correct the fixture to the real wire shape (`calExpandInst*` search hits nest instances) — the code is authoritative:

```ts
it('maps a Zimbra appointment to ProviderEvent', () => {
  const ev = mapZimbraAppointment({
    id: '401', name: 'Working session with COK',
    loc: 'KG1 Roundabout', allDay: false,
    inst: [{ s: 1757500200000 }],
    dur: 3600000,
    or: { a: 'bruce.higiro@risa.gov.rw', d: 'Bruce' },
    at: [{ a: 'alice@risa.gov.rw', d: 'Alice', ptst: 'AC' }],
    fr: 'Agenda: processes automation',
  } as any);
  expect(ev).toMatchObject({
    id: '401', title: 'Working session with COK', location: 'KG1 Roundabout',
    allDay: false,
    organizer: { email: 'bruce.higiro@risa.gov.rw', name: 'Bruce' },
    attendees: [{ email: 'alice@risa.gov.rw', name: 'Alice', ptst: 'AC' }],
  });
  expect(ev.startAt).toEqual(new Date(1757500200000));
  expect(ev.endAt).toEqual(new Date(1757500200000 + 3600000));
});
```

Run → FAIL.

- [ ] **Step 2: Implement + convert** the listed methods to `(s: MailSession, …)`, hoist appointment parsing out of `calendar.service.ts` into the mapper, update all call sites via `buildMailSession(user)`.

- [ ] **Step 3: Gates** — `npx jest src/zimbra src/calendar src/chat && npx tsc --noEmit` → PASS/clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src
git commit -m "refactor(api): Zimbra calendar domain speaks MailSession + neutral DTOs"
```

---

### Task 9: Zimbra provider — settings/auth domain + capability plumbing

**Files:**
- Modify: `apps/api/src/zimbra/zimbra.service.ts` (auth + prefs/identities/signatures/password methods; add `implements MailProvider`, `readonly name = 'zimbra'`, `readonly capabilities`), `apps/api/src/settings/settings.service.ts` + its controller (capabilities object in `GET /settings`), `apps/api/src/auth/auth.service.ts` (authenticate/verifyTwoFactor via provider shapes)
- Modify: `apps/web` settings page — render sections only when `capabilities.<flag>` is true (default true when absent, so Zimbra users see no change even mid-deploy)
- Test: extend `apps/api/src/settings/settings.service.spec.ts`; `apps/web` settings test for hidden sections

**Interfaces:**
- Consumes: Task 5 interface (settings section, `authenticate`, `verifyTwoFactor`, `MailProviderCapabilities`).
- Produces: `ZimbraService implements MailProvider` compiles; `GET /settings` response gains `capabilities: MailProviderCapabilities`.

- [ ] **Step 1: Failing test** — settings spec asserts the response includes `capabilities: { signatures: true, identities: true, serverPrefs: true, changePassword: true, twoFactor: true }` for a zimbra user. Run → FAIL.

- [ ] **Step 2: Convert remaining methods** (`authenticate` and `verifyTwoFactor` keep `(host, email, …)` — they run pre-session; map `ZimbraAuthResult` → `ProviderAuthResult`; `getPrefs, modifyPrefs, getIdentities, modifyIdentity, getSignatures, createSignature, modifySignature, deleteSignature, changePassword` → `(s: MailSession, …)`), declare:

```ts
export class ZimbraService implements MailProvider {
  readonly name = 'zimbra' as const;
  readonly capabilities = {
    signatures: true, identities: true, serverPrefs: true,
    changePassword: true, twoFactor: true,
  } as const;
  // …
}
```

`settings.service.ts` builds its response with `capabilities: provider.capabilities` (until Task 10, `provider` is the injected `ZimbraService`). Identity/signature wire shapes: if today's `SettingsService` reads Zimbra-specific fields, hoist that reading into the zimbra provider (return the already-app-shaped objects the REST layer sends), then tighten the interface's `unknown[]` to the real shapes.

- [ ] **Step 3: Web** — settings page reads `data.capabilities ?? allTrue` and gates the Signatures / Identities / server-prefs / password / 2FA sections. Vitest: with a mocked settings payload where `capabilities.signatures=false`, the signatures section is absent; with the field missing entirely, everything renders (back-compat).

- [ ] **Step 4: Gates** — `npx jest src/settings src/auth src/zimbra && npx tsc --noEmit` (api), `npx vitest run && npx tsc --noEmit` (web) → PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/web
git commit -m "refactor(api,web): settings/auth domain on provider shapes + capability flags"
```

---

### Task 10: MailProviderResolver + injection swap + acceptance sweep

**Files:**
- Create: `apps/api/src/provider/mail-provider.resolver.ts`, `apps/api/src/provider/provider.module.ts`, `apps/api/src/provider/mail-provider.resolver.spec.ts`
- Modify: the 8 feature services currently injecting `ZimbraService` (`mail`, `contacts`, `calendar`, `settings`, `auth`, `tasks.service`, `tasks.scheduler`, `docs`) + `common/signature-images.ts`
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `MailProviderResolver.forUser(user: Pick<User,'provider'>): MailProvider` and `MailProviderResolver.zimbra(): ZimbraService` (for the Zimbra-extra call sites: `downloadZimbraPath`, `galSelfLookup` — they must first check `user.provider === 'zimbra'` and skip gracefully otherwise).

- [ ] **Step 1: Failing resolver test**

```ts
it('returns ZimbraService for zimbra users and throws a clear error otherwise', () => {
  expect(resolver.forUser({ provider: 'zimbra' } as any)).toBe(zimbraService);
  expect(() => resolver.forUser({ provider: 'ews' } as any))
    .toThrow(/not supported on this server/i); // until Phase 3 registers it
  expect(() => resolver.forUser({ provider: 'memory' } as any)).toThrow();
});
```

Run → FAIL.

- [ ] **Step 2: Implement**

```ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { MailProvider } from './mail-provider.interface';
import { ZimbraService } from '../zimbra/zimbra.service';

@Injectable()
export class MailProviderResolver {
  constructor(private readonly zimbraService: ZimbraService) {}

  forUser(user: Pick<User, 'provider'>): MailProvider {
    switch (user.provider) {
      case 'zimbra': return this.zimbraService;
      default:
        throw new BadRequestException(
          `Mail provider "${user.provider}" is not supported on this server yet.`,
        );
    }
  }

  /** Zimbra-only extras (downloadZimbraPath, galSelfLookup). Callers must
   *  check user.provider === 'zimbra' and degrade gracefully otherwise. */
  zimbra(): ZimbraService { return this.zimbraService; }
}
```

`provider.module.ts` imports ZimbraModule, provides/exports the resolver. Swap every feature service: inject `MailProviderResolver`, and at each call site `const provider = this.resolver.forUser(user); provider.method(buildMailSession(user), …)`. Auth's login (Task 3) drops its "provider !== zimbra → 400" special case in favor of the resolver's error.

- [ ] **Step 3: Acceptance greps (all must return nothing)**

```bash
grep -rn "ZimbraService" apps/api/src --include="*.ts" | grep -v "src/zimbra/" | grep -v "src/provider/" | grep -v spec
grep -rnE "\.su\b|\.fr\b|_jsns" apps/api/src --include="*.ts" | grep -v "src/zimbra/" | grep -v spec
```

- [ ] **Step 4: Full gates** — `npx jest && npx tsc --noEmit` (api), `npx vitest run && npx tsc --noEmit` (web) → ALL PASS.

- [ ] **Step 5: `ARCHITECTURE.md`** — add a "Mail provider layer" section: the interface, MailSession, resolver, Institution registry/login flow, capability flags, and the two Zimbra extras. State that Phases 2 (memory) and 3 (EWS) plug in behind `MailProviderResolver` without touching feature services.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src ARCHITECTURE.md
git commit -m "feat(api): MailProviderResolver — feature services are provider-agnostic"
```

---

## Manual regression checklist (after Task 10, against a Zimbra account or mock mode)

Login via institution dropdown → inbox list, open thread, send reply, save draft, move/trash/mark-unread, search, contacts autocomplete, calendar week view + create event (no real attendees on the VMs!), settings shows all sections, briefing/Ask still answer. All identical to before.
