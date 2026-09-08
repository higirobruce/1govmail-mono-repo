# AI Phase 3b — People (Relationship Dossier + Meeting Prep Pack) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-person relationship dossier (docked panel, opened from any sender or event attendee) and an on-demand meeting prep pack on the calendar event detail panel, both with server-cached AI narratives.

**Architecture:** A new `PeopleModule` serves deterministic per-counterparty facts from indexed SQL. Two new streaming endpoints (`/ai/dossier`, `/ai/meeting-prep`) live beside `/ai/ask` in the existing chat module and reuse its fencing/prompt/SSE plumbing; generated output is cached in a new `ai_generations` table with read-time staleness. The web adds a `PersonDossierPanel` (single mount, mutually exclusive with the Ask panel) and a Prep view inside the calendar's `EventDetailPanel`.

**Tech Stack:** NestJS 11 + Prisma 7 (PostgreSQL, raw SQL uses double-quoted camelCase identifiers), Next.js 16, Zustand, vitest (web) / jest (api), Ollama upstream via existing `AiService`.

**Spec:** `docs/superpowers/specs/2026-09-06-ai-phase3b-people-design.md`

## Global Constraints

- **Prisma migrate gotcha:** `npx prisma migrate dev` will offer to DROP `message_embeddings_embedding_hnsw_idx` / the document_embeddings HNSW index — spurious drift, ALWAYS strip any such `DROP INDEX` from the generated migration SQL before applying.
- **Never run `next build` locally on ft-hyperscale** — pre-existing Next 16.1.6 Turbopack `/_global-error` prerender bug. The containerized `scripts/build-web-154.sh` build is the real gate.
- Email comparisons are **lowercased on our side** (`lower(...)` in SQL, `.toLowerCase()` in TS). Exception: the docs-leg invite ACL inside `RetrievalService` keeps its existing exact-string semantics — do not touch it.
- Client never supplies a system prompt; server owns retrieval, ACL, prompt assembly. Full context never ships to the browser — sources are ≤160-char snippets.
- All untrusted strings entering prompts (subjects, names, titles, body text) go through `neutralizeMarkers` / `fenceUntrusted` from `@email-client/shared`.
- Ownership/ACL checks run **before SSE headers flush** so errors surface as normal JSON 4xx.
- Test commands: `cd apps/web && npx vitest run` (405 tests green today), `cd apps/api && npx jest` (202 green today), `npx tsc --noEmit` in both apps.
- No new env vars. `CHAT_MODEL` default `qwen3-30b-16k:latest` (see `AskService.chatModel`).
- Commit after every task; message style `feat(scope): …` matching recent history.

---

### Task 1: Schema — `ai_generations` table + `messages` fromEmail index

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (Message `@@index`, new `AiGeneration` model, `User` back-relation)
- Create: `apps/api/prisma/migrations/<timestamp>_add_people_phase3b/migration.sql` (generated)

**Interfaces:**
- Consumes: nothing.
- Produces: `prisma.aiGeneration` client delegate with fields `{ id, userId, kind, targetKey, content, sources, model, sourceAnchor, generatedAt }`, unique on `(userId, kind, targetKey)`; index `messages(userId, fromEmail, receivedAt)`.

- [ ] **Step 1: Add the index to `Message`**

In `apps/api/prisma/schema.prisma`, inside `model Message` after `@@index([receivedAt])` add:

```prisma
  @@index([userId, fromEmail, receivedAt])
```

- [ ] **Step 2: Add the `AiGeneration` model**

Add after `model MessageEmbedding` (keeps the AI models together):

```prisma
// Server-side cache for on-demand AI generations (phase 3b): relationship
// dossiers (targetKey = lowercased counterparty email) and meeting prep packs
// (targetKey = calendarEvent id). Staleness is computed at READ time against
// sourceAnchor — never stored. One row per (user, kind, target); regeneration
// upserts over it.
model AiGeneration {
  id           String   @id @default(cuid())
  userId       String
  kind         String   // 'dossier' | 'meeting_prep'
  targetKey    String
  content      String
  sources      Json     @default("[]") // PublicAskSource[] snapshot for chip re-render
  model        String
  sourceAnchor DateTime // newest source timestamp considered at generation time
  generatedAt  DateTime @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, kind, targetKey])
  @@index([userId, kind])
  @@map("ai_generations")
}
```

And in `model User`'s relation list (after `messageEmbeddings MessageEmbedding[]`):

```prisma
  aiGenerations          AiGeneration[]
```

- [ ] **Step 3: Generate the migration**

Run: `cd apps/api && npx prisma migrate dev --name add_people_phase3b`

- [ ] **Step 4: Inspect the generated SQL**

Open the new `apps/api/prisma/migrations/*_add_people_phase3b/migration.sql`. It must contain ONLY: `CREATE TABLE "ai_generations" …`, its two indexes, the FK, and `CREATE INDEX "messages_userId_fromEmail_receivedAt_idx" …`. If Prisma's drift detection added `DROP INDEX` lines for any `*_hnsw_idx`, DELETE those lines and re-apply with `npx prisma migrate dev` (it will re-run cleanly) — this happened in phase 3a and is expected.

- [ ] **Step 5: Verify client + typecheck**

Run: `cd apps/api && npx prisma generate && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma
git commit -m "feat(api): ai_generations cache table + messages fromEmail index (phase 3b schema)"
```

---

### Task 2: PeopleModule — deterministic dossier facts

**Files:**
- Create: `apps/api/src/people/people.module.ts`, `apps/api/src/people/people.controller.ts`, `apps/api/src/people/people.service.ts`, `apps/api/src/people/dto/person.dto.ts`
- Modify: `apps/api/src/app.module.ts` (register `PeopleModule` in `imports`)
- Test: `apps/api/src/people/people.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (from `../prisma/prisma.service`).
- Produces:

```ts
export interface PersonDossier {
  profile: {
    email: string; name: string | null;
    firstSeenAt: string | null; lastSeenAt: string | null; // ISO
    received90d: number; sent90d: number;
  };
  recentConversations: Array<{
    messageId: string; conversationId: string | null;
    subject: string | null; snippet: string | null;
    direction: 'in' | 'out'; at: string; // ISO
  }>;
  commitments: Array<{
    id: string; type: 'promised' | 'waiting'; text: string;
    dueHint: string | null; messageId: string; lastActivityAt: string;
  }>;
  sharedEvents: Array<{ id: string; title: string; startAt: string; endAt: string; upcoming: boolean }>;
  sharedDocs: Array<{ id: string; title: string; emoji: string | null; direction: 'i-shared' | 'they-shared' }>;
}
// PeopleService
async dossier(userId: string, rawEmail: string): Promise<PersonDossier>
```
- Route: `GET /people/dossier?email=` (JwtAuthGuard).

- [ ] **Step 1: Write the failing tests**

`apps/api/src/people/people.service.spec.ts` — mirror the mocked-Prisma style of `apps/api/src/chat/retrieval.service.spec.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import { PeopleService } from './people.service';

const NOW = new Date('2026-09-06T10:00:00Z');

function makePrisma() {
  return {
    user: { findUnique: jest.fn().mockResolvedValue({ email: 'me@risa.gov.rw' }) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    calendarEvent: { findMany: jest.fn().mockResolvedValue([]) },
    documentInvite: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
}

describe('PeopleService.dossier', () => {
  it('rejects the user own address (case-insensitively)', async () => {
    const svc = new PeopleService(makePrisma());
    await expect(svc.dossier('u1', 'ME@risa.gov.rw')).rejects.toThrow(BadRequestException);
  });

  it('lowercases the email and builds the profile from the stats row', async () => {
    const prisma = makePrisma();
    // 1st $queryRaw = stats, 2nd = recent messages, 3rd = commitments
    prisma.$queryRaw
      .mockResolvedValueOnce([{ firstSeenAt: new Date('2026-01-01'), lastSeenAt: NOW, received90d: 7, sent90d: 3 }])
      .mockResolvedValueOnce([
        { id: 'm2', conversationId: 'c1', subject: 'Re: budget', snippet: 'ok', fromEmail: 'jd@gov.rw', fromName: 'J D', receivedAt: NOW },
        { id: 'm1', conversationId: 'c1', subject: 'budget', snippet: 'hi', fromEmail: 'me@risa.gov.rw', fromName: null, receivedAt: new Date('2026-09-01') },
      ])
      .mockResolvedValueOnce([]);
    const d = await new PeopleService(prisma).dossier('u1', 'JD@gov.rw');
    expect(d.profile).toEqual({
      email: 'jd@gov.rw', name: 'J D',
      firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: NOW.toISOString(),
      received90d: 7, sent90d: 3,
    });
  });

  it('dedupes recentConversations by conversationId keeping the newest, marks direction', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ firstSeenAt: null, lastSeenAt: null, received90d: 0, sent90d: 0 }])
      .mockResolvedValueOnce([
        { id: 'm3', conversationId: 'c1', subject: 'Re: x', snippet: null, fromEmail: 'jd@gov.rw', fromName: null, receivedAt: NOW },
        { id: 'm2', conversationId: 'c1', subject: 'x', snippet: null, fromEmail: 'me@risa.gov.rw', fromName: null, receivedAt: new Date('2026-09-01') },
        { id: 'm1', conversationId: null, subject: 'solo', snippet: null, fromEmail: 'jd@gov.rw', fromName: null, receivedAt: new Date('2026-08-01') },
      ])
      .mockResolvedValueOnce([]);
    const d = await new PeopleService(prisma).dossier('u1', 'jd@gov.rw');
    expect(d.recentConversations.map((c) => c.messageId)).toEqual(['m3', 'm1']);
    expect(d.recentConversations[0].direction).toBe('in');
  });

  it('splits sharedEvents into upcoming (asc, max 5) and past (desc, max 3)', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ firstSeenAt: null, lastSeenAt: null, received90d: 0, sent90d: 0 }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([])
      // 4th $queryRaw = shared events
      .mockResolvedValueOnce([
        { id: 'e-past', title: 'old', startAt: new Date('2026-08-01T09:00Z'), endAt: new Date('2026-08-01T10:00Z') },
        { id: 'e-next', title: 'next', startAt: new Date('2026-09-08T09:00Z'), endAt: new Date('2026-09-08T10:00Z') },
        { id: 'e-later', title: 'later', startAt: new Date('2026-09-20T09:00Z'), endAt: new Date('2026-09-20T10:00Z') },
      ]);
    const d = await new PeopleService(prisma).dossier('u1', 'jd@gov.rw');
    expect(d.sharedEvents.map((e) => e.id)).toEqual(['e-next', 'e-later', 'e-past']);
    expect(d.sharedEvents[0].upcoming).toBe(true);
    expect(d.sharedEvents[2].upcoming).toBe(false);
  });

  it('splits sharedDocs by direction', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ firstSeenAt: null, lastSeenAt: null, received90d: 0, sent90d: 0 }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prisma.documentInvite.findMany
      .mockResolvedValueOnce([{ document: { id: 'd1', title: 'Mine', emoji: null } }])   // i-shared
      .mockResolvedValueOnce([{ document: { id: 'd2', title: 'Theirs', emoji: '📄' } }]); // they-shared
    const d = await new PeopleService(prisma).dossier('u1', 'jd@gov.rw');
    expect(d.sharedDocs).toEqual([
      { id: 'd1', title: 'Mine', emoji: null, direction: 'i-shared' },
      { id: 'd2', title: 'Theirs', emoji: '📄', direction: 'they-shared' },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest people.service --verbose`
Expected: FAIL — `Cannot find module './people.service'`.

- [ ] **Step 3: Implement `PeopleService`**

`apps/api/src/people/people.service.ts`:

```ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 86_400_000;
const STATS_WINDOW_DAYS = 90;
const RECENT_MESSAGE_SCAN = 50; // rows scanned to derive 8 conversations + display name
const MAX_CONVERSATIONS = 8;
const EVENT_WINDOW_DAYS = 365;
const MAX_UPCOMING_EVENTS = 5;
const MAX_PAST_EVENTS = 3;

export interface PersonDossier { /* exactly the interface from this task's Interfaces block */
  profile: { email: string; name: string | null; firstSeenAt: string | null; lastSeenAt: string | null; received90d: number; sent90d: number };
  recentConversations: Array<{ messageId: string; conversationId: string | null; subject: string | null; snippet: string | null; direction: 'in' | 'out'; at: string }>;
  commitments: Array<{ id: string; type: 'promised' | 'waiting'; text: string; dueHint: string | null; messageId: string; lastActivityAt: string }>;
  sharedEvents: Array<{ id: string; title: string; startAt: string; endAt: string; upcoming: boolean }>;
  sharedDocs: Array<{ id: string; title: string; emoji: string | null; direction: 'i-shared' | 'they-shared' }>;
}

/**
 * Deterministic per-counterparty facts. A "person" is a lowercased email
 * address; involvement = they sent it (fromEmail) OR they're in toRecipients
 * ({email,name} JSONB elements — see mail.service.ts sync mapping).
 */
@Injectable()
export class PeopleService {
  constructor(private readonly prisma: PrismaService) {}

  async dossier(userId: string, rawEmail: string): Promise<PersonDossier> {
    const email = rawEmail.trim().toLowerCase();
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (me?.email?.toLowerCase() === email) {
      throw new BadRequestException('cannot open a dossier on yourself');
    }

    const cutoff = new Date(Date.now() - STATS_WINDOW_DAYS * DAY_MS);

    // The involvement predicate appears in three queries below — keep the
    // copies textually identical (fromEmail leg is indexed; the toRecipients
    // EXISTS leg is a scan, fine at this corpus size).
    const [stats] = await this.prisma.$queryRaw<Array<{
      firstSeenAt: Date | null; lastSeenAt: Date | null; received90d: number; sent90d: number;
    }>>`
      SELECT min(m."receivedAt") AS "firstSeenAt", max(m."receivedAt") AS "lastSeenAt",
             count(*) FILTER (WHERE lower(m."fromEmail") = ${email} AND m."receivedAt" >= ${cutoff})::int AS "received90d",
             count(*) FILTER (WHERE lower(m."fromEmail") <> ${email} AND m."receivedAt" >= ${cutoff})::int AS "sent90d"
      FROM "messages" m
      WHERE m."userId" = ${userId} AND m."isDraft" = false
        AND (lower(m."fromEmail") = ${email}
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(m."toRecipients") r
                        WHERE lower(r->>'email') = ${email}))`;

    const recent = await this.prisma.$queryRaw<Array<{
      id: string; conversationId: string | null; subject: string | null; snippet: string | null;
      fromEmail: string; fromName: string | null; receivedAt: Date;
    }>>`
      SELECT m."id", m."conversationId", m."subject", m."snippet", m."fromEmail", m."fromName", m."receivedAt"
      FROM "messages" m
      WHERE m."userId" = ${userId} AND m."isDraft" = false
        AND (lower(m."fromEmail") = ${email}
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(m."toRecipients") r
                        WHERE lower(r->>'email') = ${email}))
      ORDER BY m."receivedAt" DESC
      LIMIT ${RECENT_MESSAGE_SCAN}`;

    const name = recent.find((m) => m.fromEmail.toLowerCase() === email && m.fromName)?.fromName ?? null;

    const seenConvs = new Set<string>();
    const recentConversations: PersonDossier['recentConversations'] = [];
    for (const m of recent) {
      const key = m.conversationId ?? `msg:${m.id}`;
      if (seenConvs.has(key)) continue;
      seenConvs.add(key);
      recentConversations.push({
        messageId: m.id, conversationId: m.conversationId, subject: m.subject, snippet: m.snippet,
        direction: m.fromEmail.toLowerCase() === email ? 'in' : 'out',
        at: m.receivedAt.toISOString(),
      });
      if (recentConversations.length >= MAX_CONVERSATIONS) break;
    }

    const commitmentRows = await this.prisma.$queryRaw<Array<{
      id: string; type: string; text: string; dueHint: string | null; messageId: string; lastActivityAt: Date;
    }>>`
      SELECT c."id", c."type", c."text", c."dueHint", c."messageId", c."lastActivityAt"
      FROM "commitments" c
      JOIN "messages" m ON m."id" = c."messageId"
      WHERE c."userId" = ${userId} AND c."status" = 'open'
        AND (lower(m."fromEmail") = ${email}
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(m."toRecipients") r
                        WHERE lower(r->>'email') = ${email}))
      ORDER BY c."lastActivityAt" DESC`;

    const now = Date.now();
    const eventRows = await this.prisma.$queryRaw<Array<{
      id: string; title: string; startAt: Date; endAt: Date;
    }>>`
      SELECT e."id", e."title", e."startAt", e."endAt"
      FROM "calendar_events" e
      WHERE e."userId" = ${userId}
        AND e."startAt" BETWEEN ${new Date(now - EVENT_WINDOW_DAYS * DAY_MS)} AND ${new Date(now + EVENT_WINDOW_DAYS * DAY_MS)}
        AND (lower(coalesce(e."organizer", '')) = ${email}
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(e."attendees") a
                        WHERE lower(a->>'email') = ${email}))`;
    const upcoming = eventRows.filter((e) => e.startAt.getTime() >= now)
      .sort((a, b) => a.startAt.getTime() - b.startAt.getTime()).slice(0, MAX_UPCOMING_EVENTS);
    const past = eventRows.filter((e) => e.startAt.getTime() < now)
      .sort((a, b) => b.startAt.getTime() - a.startAt.getTime()).slice(0, MAX_PAST_EVENTS);
    const sharedEvents = [...upcoming, ...past].map((e) => ({
      id: e.id, title: e.title, startAt: e.startAt.toISOString(), endAt: e.endAt.toISOString(),
      upcoming: e.startAt.getTime() >= now,
    }));

    const iShared = await this.prisma.documentInvite.findMany({
      where: { invitedEmail: { equals: email, mode: 'insensitive' }, document: { userId } },
      select: { document: { select: { id: true, title: true, emoji: true } } },
    });
    const theyShared = await this.prisma.documentInvite.findMany({
      where: {
        invitedEmail: { equals: me?.email ?? '', mode: 'insensitive' },
        document: { user: { email: { equals: email, mode: 'insensitive' } } },
      },
      select: { document: { select: { id: true, title: true, emoji: true } } },
    });

    return {
      profile: {
        email, name,
        firstSeenAt: stats?.firstSeenAt?.toISOString() ?? null,
        lastSeenAt: stats?.lastSeenAt?.toISOString() ?? null,
        received90d: stats?.received90d ?? 0, sent90d: stats?.sent90d ?? 0,
      },
      recentConversations,
      commitments: commitmentRows.map((c) => ({
        id: c.id, type: c.type as 'promised' | 'waiting', text: c.text, dueHint: c.dueHint,
        messageId: c.messageId, lastActivityAt: c.lastActivityAt.toISOString(),
      })),
      sharedEvents,
      sharedDocs: [
        ...iShared.map((i) => ({ ...i.document, direction: 'i-shared' as const })),
        ...theyShared.map((i) => ({ ...i.document, direction: 'they-shared' as const })),
      ],
    };
  }
}
```

- [ ] **Step 4: DTO, controller, module, registration**

`apps/api/src/people/dto/person.dto.ts`:

```ts
import { IsEmail } from 'class-validator';

export class PersonDossierQueryDto {
  @IsEmail()
  email!: string;
}
```

`apps/api/src/people/people.controller.ts`:

```ts
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PeopleService, type PersonDossier } from './people.service';
import { PersonDossierQueryDto } from './dto/person.dto';

interface AuthenticatedRequest extends Request {
  user: { sub: string };
}

@UseGuards(JwtAuthGuard)
@Controller('people')
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  @Get('dossier')
  dossier(@Req() req: AuthenticatedRequest, @Query() q: PersonDossierQueryDto): Promise<PersonDossier> {
    return this.people.dossier(req.user.sub, q.email);
  }
}
```

`apps/api/src/people/people.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PeopleService } from './people.service';
import { PeopleController } from './people.controller';

@Module({
  imports: [PrismaModule],
  providers: [PeopleService],
  controllers: [PeopleController],
  exports: [PeopleService],
})
export class PeopleModule {}
```

Register `PeopleModule` in `apps/api/src/app.module.ts` `imports` (alphabetically near the other feature modules).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx jest people.service --verbose`
Expected: 5 PASS.

- [ ] **Step 6: Full api suite + typecheck, then commit**

Run: `cd apps/api && npx jest && npx tsc --noEmit`

```bash
git add apps/api/src/people apps/api/src/app.module.ts
git commit -m "feat(api): PeopleModule — deterministic per-person dossier facts"
```

---

### Task 3: GenerationCacheService — cached narratives with read-time staleness

**Files:**
- Create: `apps/api/src/chat/generation-cache.service.ts`
- Modify: `apps/api/src/chat/chat.module.ts` (add provider)
- Test: `apps/api/src/chat/generation-cache.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`; `PublicAskSource` type from `./ask.service`.
- Produces:

```ts
export type GenerationKind = 'dossier' | 'meeting_prep';
export interface CachedGeneration { content: string; sources: PublicAskSource[]; generatedAt: string; stale: boolean }
// GenerationCacheService
async get(userId: string, kind: GenerationKind, targetKey: string): Promise<CachedGeneration | null>
async upsert(userId: string, kind: GenerationKind, targetKey: string,
             data: { content: string; sources: PublicAskSource[]; model: string; sourceAnchor: Date }): Promise<void>
```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/chat/generation-cache.service.spec.ts`:

```ts
import { GenerationCacheService } from './generation-cache.service';

const ANCHOR = new Date('2026-09-05T12:00:00Z');
const ROW = {
  content: 'brief', sources: [], model: 'm', sourceAnchor: ANCHOR,
  generatedAt: new Date('2026-09-05T12:01:00Z'),
};

function makePrisma() {
  return {
    aiGeneration: { findUnique: jest.fn(), upsert: jest.fn().mockResolvedValue({}) },
    calendarEvent: { findFirst: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([{ newest: null }]),
  } as any;
}

describe('GenerationCacheService', () => {
  it('returns null when no row', async () => {
    const prisma = makePrisma();
    prisma.aiGeneration.findUnique.mockResolvedValue(null);
    expect(await new GenerationCacheService(prisma).get('u1', 'dossier', 'jd@gov.rw')).toBeNull();
  });

  it('dossier: fresh when no newer mail involves the person', async () => {
    const prisma = makePrisma();
    prisma.aiGeneration.findUnique.mockResolvedValue(ROW);
    prisma.$queryRaw.mockResolvedValue([{ newest: ANCHOR }]); // nothing after anchor
    const got = await new GenerationCacheService(prisma).get('u1', 'dossier', 'jd@gov.rw');
    expect(got).toEqual({ content: 'brief', sources: [], generatedAt: ROW.generatedAt.toISOString(), stale: false });
  });

  it('dossier: stale when newer mail exists', async () => {
    const prisma = makePrisma();
    prisma.aiGeneration.findUnique.mockResolvedValue(ROW);
    prisma.$queryRaw.mockResolvedValue([{ newest: new Date('2026-09-06T08:00:00Z') }]);
    const got = await new GenerationCacheService(prisma).get('u1', 'dossier', 'jd@gov.rw');
    expect(got?.stale).toBe(true);
  });

  it('meeting_prep: null when the event is gone (or not the caller’s)', async () => {
    const prisma = makePrisma();
    prisma.aiGeneration.findUnique.mockResolvedValue(ROW);
    prisma.calendarEvent.findFirst.mockResolvedValue(null);
    expect(await new GenerationCacheService(prisma).get('u1', 'meeting_prep', 'e1')).toBeNull();
  });

  it('meeting_prep: stale when the event was updated after the anchor', async () => {
    const prisma = makePrisma();
    prisma.aiGeneration.findUnique.mockResolvedValue(ROW);
    prisma.calendarEvent.findFirst.mockResolvedValue({
      updatedAt: new Date('2026-09-06T09:00:00Z'), attendees: [],
    });
    const got = await new GenerationCacheService(prisma).get('u1', 'meeting_prep', 'e1');
    expect(got?.stale).toBe(true);
  });

  it('meeting_prep: stale when newer mail from an attendee exists', async () => {
    const prisma = makePrisma();
    prisma.aiGeneration.findUnique.mockResolvedValue(ROW);
    prisma.calendarEvent.findFirst.mockResolvedValue({
      updatedAt: new Date('2026-09-01T00:00:00Z'),
      attendees: [{ email: 'JD@gov.rw' }],
    });
    prisma.$queryRaw.mockResolvedValue([{ newest: new Date('2026-09-06T08:00:00Z') }]);
    const got = await new GenerationCacheService(prisma).get('u1', 'meeting_prep', 'e1');
    expect(got?.stale).toBe(true);
  });

  it('upsert writes the unique triple', async () => {
    const prisma = makePrisma();
    await new GenerationCacheService(prisma).upsert('u1', 'dossier', 'jd@gov.rw', {
      content: 'x', sources: [], model: 'm', sourceAnchor: ANCHOR,
    });
    expect(prisma.aiGeneration.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_kind_targetKey: { userId: 'u1', kind: 'dossier', targetKey: 'jd@gov.rw' } },
    }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest generation-cache --verbose`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/api/src/chat/generation-cache.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { PublicAskSource } from './ask.service';

export type GenerationKind = 'dossier' | 'meeting_prep';

export interface CachedGeneration {
  content: string;
  sources: PublicAskSource[];
  generatedAt: string; // ISO
  stale: boolean;
}

/**
 * Server-side cache for dossier / meeting-prep generations. Staleness is
 * computed at READ time against the stored sourceAnchor:
 *  - dossier: any mail involving the person newer than the anchor
 *  - meeting_prep: event.updatedAt past the anchor, or newer INBOUND mail
 *    from any attendee (outbound is skipped deliberately — a cheap
 *    fromEmail-indexed check; regeneration is user-initiated anyway).
 * Stale rows are still served with stale:true — never auto-regenerated.
 */
@Injectable()
export class GenerationCacheService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string, kind: GenerationKind, targetKey: string): Promise<CachedGeneration | null> {
    const row = await this.prisma.aiGeneration.findUnique({
      where: { userId_kind_targetKey: { userId, kind, targetKey } },
    });
    if (!row) return null;

    let stale = false;
    if (kind === 'dossier') {
      const newest = await this.newestInvolving(userId, [targetKey]);
      stale = !!newest && newest.getTime() > row.sourceAnchor.getTime();
    } else {
      const event = await this.prisma.calendarEvent.findFirst({
        where: { id: targetKey, userId },
        select: { updatedAt: true, attendees: true },
      });
      if (!event) return null; // event deleted or not the caller's — cache row is orphaned
      stale = event.updatedAt.getTime() > row.sourceAnchor.getTime();
      if (!stale) {
        const emails = (Array.isArray(event.attendees) ? (event.attendees as Array<{ email?: string }>) : [])
          .map((a) => a?.email?.toLowerCase()).filter((e): e is string => !!e);
        if (emails.length) {
          const newest = await this.newestFrom(userId, emails);
          stale = !!newest && newest.getTime() > row.sourceAnchor.getTime();
        }
      }
    }

    return {
      content: row.content,
      sources: (row.sources as unknown as PublicAskSource[]) ?? [],
      generatedAt: row.generatedAt.toISOString(),
      stale,
    };
  }

  async upsert(
    userId: string, kind: GenerationKind, targetKey: string,
    data: { content: string; sources: PublicAskSource[]; model: string; sourceAnchor: Date },
  ): Promise<void> {
    const payload = {
      content: data.content,
      sources: data.sources as unknown as object,
      model: data.model,
      sourceAnchor: data.sourceAnchor,
      generatedAt: new Date(),
    };
    await this.prisma.aiGeneration.upsert({
      where: { userId_kind_targetKey: { userId, kind, targetKey } },
      create: { userId, kind, targetKey, ...payload },
      update: payload,
    });
  }

  /** Newest mail involving the (lowercased) email in either direction. */
  private async newestInvolving(userId: string, emails: string[]): Promise<Date | null> {
    const [row] = await this.prisma.$queryRaw<Array<{ newest: Date | null }>>`
      SELECT max(m."receivedAt") AS newest FROM "messages" m
      WHERE m."userId" = ${userId} AND m."isDraft" = false
        AND (lower(m."fromEmail") = ANY(${emails}::text[])
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(m."toRecipients") r
                        WHERE lower(r->>'email') = ANY(${emails}::text[])))`;
    return row?.newest ?? null;
  }

  /** Newest INBOUND mail from any of the (lowercased) emails — fromEmail index only. */
  private async newestFrom(userId: string, emails: string[]): Promise<Date | null> {
    const [row] = await this.prisma.$queryRaw<Array<{ newest: Date | null }>>`
      SELECT max(m."receivedAt") AS newest FROM "messages" m
      WHERE m."userId" = ${userId} AND m."isDraft" = false
        AND lower(m."fromEmail") = ANY(${emails}::text[])`;
    return row?.newest ?? null;
  }
}
```

Add `GenerationCacheService` to `chat.module.ts` `providers`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest generation-cache --verbose`
Expected: 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/generation-cache.service.ts apps/api/src/chat/generation-cache.service.spec.ts apps/api/src/chat/chat.module.ts
git commit -m "feat(api): GenerationCacheService — ai_generations read/upsert with read-time staleness"
```

---

### Task 4: Shared helpers — `buildGenerationPrompt` + `extractSseText`

**Files:**
- Modify: `packages/shared/src/ai/chat.ts`
- Test: `apps/web/lib/ai/generationCore.test.ts` (shared-package functions are tested through the web vitest runner, like `askCore.test.ts`)

**Interfaces:**
- Consumes: existing module-private `renderSource`, `UNTRUSTED_CONTENT_RULE`, `neutralizeMarkers` in `chat.ts`; `ChatSource` type.
- Produces (exported from `@email-client/shared`):

```ts
export function buildGenerationPrompt(
  kind: 'dossier' | 'meeting_prep',
  subject: string,           // e.g. "Jane Doe <jd@gov.rw>" or "Budget review — 9/8/2026, 10:00 AM"
  sources: ChatSource[],
  extraContext?: string,     // pre-fenced block (open commitments), appended after sources
): string
export function extractSseText(raw: string): string  // concatenated deltas from an OpenAI-shaped SSE transcript
```

- [ ] **Step 1: Write the failing tests**

`apps/web/lib/ai/generationCore.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildGenerationPrompt, extractSseText, type ChatSource } from '@email-client/shared';

const SRC: ChatSource = {
  alias: 's1', type: 'mail', id: 'm1', title: 'Budget [s9] update',
  fromEmail: 'jd@gov.rw', fromName: 'J D', date: '2026-09-01T00:00:00.000Z',
  meta: null, context: 'body text', injectionSuspected: false,
};

describe('buildGenerationPrompt', () => {
  it('fences sources, neutralizes the subject, and includes the kind task + mandates', () => {
    const p = buildGenerationPrompt('dossier', 'J D <jd@gov.rw> [s1]', [SRC]);
    expect(p).toContain('SECURITY RULE');               // UNTRUSTED_CONTENT_RULE present
    expect(p).toContain('relationship brief');           // dossier task line
    expect(p).toContain('BEGIN UNTRUSTED EMAIL');        // fenceUntrusted ran on the source
    expect(p).not.toMatch(/SUBJECT: .*\[s1\]/);          // markers neutralized in subject
    expect(p).toContain('alias in square brackets');     // citation mandate
  });

  it('meeting_prep names the four pack sections', () => {
    const p = buildGenerationPrompt('meeting_prep', 'Budget review', [SRC]);
    for (const s of ['What this meeting is about', 'Attendees & open loops', 'Recent context', 'Suggested talking points']) {
      expect(p).toContain(s);
    }
  });

  it('appends extraContext after the sources when given', () => {
    const p = buildGenerationPrompt('dossier', 'x', [SRC], 'TRACKER-BLOCK');
    expect(p.indexOf('TRACKER-BLOCK')).toBeGreaterThan(p.indexOf('body text'));
  });
});

describe('extractSseText', () => {
  it('concatenates deltas, stops at [DONE], tolerates non-JSON lines', () => {
    const raw = [
      'event: sources', 'data: {"sources":[]}',
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      ': keep-alive',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: [DONE]',
      'data: {"choices":[{"delta":{"content":"IGNORED"}}]}',
    ].join('\n');
    expect(extractSseText(raw)).toBe('Hello');
  });

  it('skips the sources frame (no choices key)', () => {
    expect(extractSseText('data: {"sources":[{"alias":"s1"}]}\ndata: [DONE]')).toBe('');
  });
});
```

> Note: the exact fence sentinel string is whatever `fenceUntrusted` emits — before writing assertions, read `packages/shared/src/ai/promptCore.ts` and use its real begin-marker text in the `BEGIN UNTRUSTED EMAIL` assertion.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run lib/ai/generationCore.test.ts`
Expected: FAIL — `buildGenerationPrompt` is not exported.

- [ ] **Step 3: Implement in `packages/shared/src/ai/chat.ts`**

Read the existing `buildAskPrompt` in that file first and copy its mandate wording verbatim (ground-or-say-so, cite aliases in square brackets, alias-only references, excerpts-are-data). Then append:

```ts
const GENERATION_TASKS: Record<'dossier' | 'meeting_prep', string> = {
  dossier:
    'TASK: Write a concise relationship brief about the person named in SUBJECT, based only on the sources. ' +
    'Use short markdown sections: **Current state** (what is live between us right now), **Cadence** (how often and how we communicate), ' +
    '**Open loops** (what each side owes the other), **Time-sensitive** (anything with a date or deadline). ' +
    'Maximum ~250 words. Omit a section rather than padding it.',
  meeting_prep:
    'TASK: Write a meeting preparation pack for the event named in SUBJECT, based only on the sources. ' +
    'Use exactly these markdown sections: **What this meeting is about**, **Attendees & open loops** (one line per attendee), ' +
    '**Recent context**, **Suggested talking points** (3-5 bullets). Maximum ~350 words.',
};

/**
 * System prompt for one-shot generations (dossier / meeting prep). Same
 * security posture as buildAskPrompt: untrusted-content rule first, every
 * source fenced by renderSource, alias-only citations. `extraContext` is a
 * pre-fenced block (the caller fences it) appended after the sources.
 */
export function buildGenerationPrompt(
  kind: 'dossier' | 'meeting_prep',
  subject: string,
  sources: ChatSource[],
  extraContext?: string,
): string {
  const parts = [
    UNTRUSTED_CONTENT_RULE,
    GENERATION_TASKS[kind],
    `SUBJECT: ${neutralizeMarkers(subject)}`,
    // ← copy buildAskPrompt's mandate block verbatim here
    `SOURCES:\n\n${sources.map(renderSource).join('\n\n')}`,
  ];
  if (extraContext) parts.push(extraContext);
  return parts.join('\n\n');
}

/**
 * Pulls the assistant text back out of a raw OpenAI-shaped SSE transcript —
 * the server pipes upstream bytes to the client verbatim and accumulates the
 * same bytes to cache the finished generation.
 */
export function extractSseText(raw: string): string {
  let out = '';
  for (const line of raw.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('data:')) continue;
    const payload = l.slice(5).trim();
    if (payload === '[DONE]') break;
    try {
      const parsed = JSON.parse(payload);
      out += parsed?.choices?.[0]?.delta?.content ?? '';
    } catch {
      /* keep-alive / non-JSON line */
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run lib/ai/generationCore.test.ts`
Expected: PASS. Also run `cd apps/web && npx vitest run lib/ai` to confirm no existing prompt tests broke.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/ai/chat.ts apps/web/lib/ai/generationCore.test.ts
git commit -m "feat(shared): buildGenerationPrompt + extractSseText for phase 3b generations"
```

---

### Task 5: DossierService — AI narrative preparation

**Files:**
- Create: `apps/api/src/chat/dossier.service.ts`
- Modify: `apps/api/src/chat/chat.module.ts` (provider)
- Test: `apps/api/src/chat/dossier.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`; `buildGenerationPrompt`, `fenceUntrusted`, `neutralizeMarkers`, `detectInjectionAttempt`, `extractEmailText`, `clampText`, `ChatSource` from `@email-client/shared`; `PublicAskSource` from `./ask.service`; `ChatRequestDto` from `../ai/dto/chat.dto`.
- Produces:

```ts
export interface PreparedGeneration {
  kind: GenerationKind;              // from ./generation-cache.service
  targetKey: string;                 // lowercased email | eventId
  sources: PublicAskSource[];
  degraded: Record<string, boolean>; // per-leg flags, feature-specific keys
  upstreamBody: ChatRequestDto | null; // null => reply with fallbackReply, no model call, no cache write
  fallbackReply: string | null;
  sourceAnchor: Date;
}
// DossierService
readonly chatModel: string
async prepare(userId: string, rawEmail: string): Promise<PreparedGeneration>
```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/chat/dossier.service.spec.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import { DossierService } from './dossier.service';

const NOW = new Date('2026-09-06T10:00:00Z');
const MAIL_ROW = {
  id: 'm1', subject: 'Budget', snippet: 'snip', bodyText: 'full body', bodyHtml: null,
  fromEmail: 'jd@gov.rw', fromName: 'J D', receivedAt: NOW, gist: null, cardFlag: null,
};

function makePrisma() {
  return {
    user: { findUnique: jest.fn().mockResolvedValue({ email: 'me@risa.gov.rw' }) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    calendarEvent: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
}

describe('DossierService.prepare', () => {
  it('rejects own address', async () => {
    await expect(new DossierService(makePrisma()).prepare('u1', 'me@risa.gov.rw'))
      .rejects.toThrow(BadRequestException);
  });

  it('falls back with no model call when there is no data at all', async () => {
    const p = await new DossierService(makePrisma()).prepare('u1', 'jd@gov.rw');
    expect(p.upstreamBody).toBeNull();
    expect(p.fallbackReply).toContain('nothing on file');
    expect(p.sources).toEqual([]);
  });

  it('builds mail sources (gist preferred over body), sets anchor to newest mail', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([                                    // mail leg
        { ...MAIL_ROW, gist: 'the gist', cardFlag: false },
        { ...MAIL_ROW, id: 'm0', receivedAt: new Date('2026-09-01T00:00:00Z') },
      ])
      .mockResolvedValueOnce([]);                                 // commitments leg
    const p = await new DossierService(prisma).prepare('u1', 'JD@gov.rw');
    expect(p.targetKey).toBe('jd@gov.rw');
    expect(p.sources).toHaveLength(2);
    expect(p.sources[0].snippet.startsWith('the gist')).toBe(true);
    expect(p.sourceAnchor).toEqual(NOW);
    expect(p.upstreamBody?.messages[0].role).toBe('system');
    expect(p.upstreamBody?.messages[0].content).toContain('relationship brief');
  });

  it('flags injection-suspected sources (card flag OR detector)', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ ...MAIL_ROW, cardFlag: true }])
      .mockResolvedValueOnce([]);
    const p = await new DossierService(prisma).prepare('u1', 'jd@gov.rw');
    expect(p.sources[0].injectionSuspected).toBe(true);
  });

  it('degrades a failed leg instead of throwing', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([MAIL_ROW])
      .mockRejectedValueOnce(new Error('boom'));                  // commitments leg fails
    const p = await new DossierService(prisma).prepare('u1', 'jd@gov.rw');
    expect(p.degraded.commitments).toBe(true);
    expect(p.upstreamBody).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest dossier.service --verbose`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/api/src/chat/dossier.service.ts`:

```ts
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  buildGenerationPrompt, clampText, detectInjectionAttempt, extractEmailText,
  fenceUntrusted, neutralizeMarkers, type ChatSource,
} from '@email-client/shared';
import { ChatRequestDto } from '../ai/dto/chat.dto';
import { PrismaService } from '../prisma/prisma.service';
import type { PublicAskSource } from './ask.service';
import type { GenerationKind } from './generation-cache.service';

const DAY_MS = 86_400_000;
const MAIL_CONTEXT_LIMIT = 15;
const EVENT_LOOKAHEAD_DAYS = 30;
const PER_SOURCE_MAX_CHARS = 800;

export interface PreparedGeneration {
  kind: GenerationKind;
  targetKey: string;
  sources: PublicAskSource[];
  degraded: Record<string, boolean>;
  upstreamBody: ChatRequestDto | null;
  fallbackReply: string | null;
  sourceAnchor: Date;
}

export const NO_DOSSIER_DATA_REPLY =
  'There is nothing on file with this person yet — no mail, open commitments, or shared events.';

@Injectable()
export class DossierService {
  private readonly logger = new Logger(DossierService.name);
  readonly chatModel = process.env.CHAT_MODEL ?? 'qwen3-30b-16k:latest';

  constructor(private readonly prisma: PrismaService) {}

  async prepare(userId: string, rawEmail: string): Promise<PreparedGeneration> {
    const email = rawEmail.trim().toLowerCase();
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (me?.email?.toLowerCase() === email) {
      throw new BadRequestException('cannot open a dossier on yourself');
    }

    const [mailLeg, commitmentLeg, eventLeg] = await Promise.allSettled([
      this.mailLeg(userId, email),
      this.commitmentLeg(userId, email),
      this.eventLeg(userId, email),
    ]);
    const degraded = {
      mail: mailLeg.status === 'rejected',
      commitments: commitmentLeg.status === 'rejected',
      events: eventLeg.status === 'rejected',
    };
    for (const [name, leg] of Object.entries({ mail: mailLeg, commitments: commitmentLeg, events: eventLeg })) {
      if (leg.status === 'rejected') this.logger.warn(`dossier ${name} leg failed: ${leg.reason?.message}`);
    }

    const mail = mailLeg.status === 'fulfilled' ? mailLeg.value : [];
    const commitments = commitmentLeg.status === 'fulfilled' ? commitmentLeg.value : [];
    const events = eventLeg.status === 'fulfilled' ? eventLeg.value : [];

    // Anchor: newest mail considered; with no mail, anchor=now so ANY future
    // mail from this person marks the cached brief stale.
    const sourceAnchor = mail[0]?.dateObj ?? new Date();

    const internal: ChatSource[] = [...mail, ...events].map((s, i) => ({ ...s.chatSource, alias: `s${i + 1}` }));

    if (internal.length === 0 && commitments.length === 0) {
      return {
        kind: 'dossier', targetKey: email, sources: [], degraded,
        upstreamBody: null, fallbackReply: NO_DOSSIER_DATA_REPLY, sourceAnchor,
      };
    }

    const personLabel = mail.find((m) => m.inbound && m.fromName)?.fromName;
    const subject = personLabel ? `${personLabel} <${email}>` : email;

    // Commitments are OUR tracker's extraction of untrusted mail — fence them
    // as a non-citable TRACKER block rather than minting aliases for them.
    const extra = commitments.length
      ? fenceUntrusted(
          'TRACKER',
          commitments
            .map((c) => `- [${c.type}] ${neutralizeMarkers(c.text)}${c.dueHint ? ` (due hint: ${neutralizeMarkers(c.dueHint)})` : ''}`)
            .join('\n'),
        )
      : undefined;

    const system = buildGenerationPrompt('dossier', subject, internal, extra);

    return {
      kind: 'dossier',
      targetKey: email,
      sources: internal.map((s) => ({
        alias: s.alias, type: s.type, id: s.id, title: s.title,
        fromEmail: s.fromEmail, fromName: s.fromName, date: s.date,
        meta: s.meta, injectionSuspected: s.injectionSuspected,
        snippet: s.context.slice(0, 160),
      })),
      degraded,
      upstreamBody: {
        model: this.chatModel,
        messages: [
          { role: 'system' as const, content: system },
          { role: 'user' as const, content: clampText('Write the relationship brief now.', 2000) },
        ],
        stream: true,
        temperature: 0.2,
        max_tokens: 700,
      } as ChatRequestDto,
      fallbackReply: null,
      sourceAnchor,
    };
  }

  private async mailLeg(userId: string, email: string) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string; subject: string | null; snippet: string | null;
      bodyText: string | null; bodyHtml: string | null;
      fromEmail: string; fromName: string | null; receivedAt: Date;
      gist: string | null; cardFlag: boolean | null;
    }>>`
      SELECT m."id", m."subject", m."snippet", m."bodyText", m."bodyHtml",
             m."fromEmail", m."fromName", m."receivedAt",
             c."gist", c."injectionSuspected" AS "cardFlag"
      FROM "messages" m
      LEFT JOIN "message_cards" c ON c."messageId" = m."id" AND c."failed" = false
      WHERE m."userId" = ${userId} AND m."isDraft" = false
        AND (lower(m."fromEmail") = ${email}
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(m."toRecipients") r
                        WHERE lower(r->>'email') = ${email}))
      ORDER BY m."receivedAt" DESC
      LIMIT ${MAIL_CONTEXT_LIMIT}`;

    return rows.map((r) => {
      const context = (
        r.gist ??
        extractEmailText({ bodyText: r.bodyText, bodyHtml: r.bodyHtml }, { maxChars: PER_SOURCE_MAX_CHARS }) ??
        r.snippet ?? ''
      ).slice(0, PER_SOURCE_MAX_CHARS);
      const chatSource: Omit<ChatSource, 'alias'> = {
        type: 'mail', id: r.id, title: r.subject,
        fromEmail: r.fromEmail, fromName: r.fromName,
        date: r.receivedAt.toISOString(), meta: null, context,
        injectionSuspected: (r.cardFlag ?? false) || detectInjectionAttempt(context),
      };
      return { chatSource, dateObj: r.receivedAt, inbound: r.fromEmail.toLowerCase() === email, fromName: r.fromName };
    }).filter((m) => m.chatSource.context.length > 0);
  }

  private async commitmentLeg(userId: string, email: string) {
    return this.prisma.$queryRaw<Array<{ type: string; text: string; dueHint: string | null }>>`
      SELECT c."type", c."text", c."dueHint"
      FROM "commitments" c
      JOIN "messages" m ON m."id" = c."messageId"
      WHERE c."userId" = ${userId} AND c."status" = 'open'
        AND (lower(m."fromEmail") = ${email}
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(m."toRecipients") r
                        WHERE lower(r->>'email') = ${email}))
      ORDER BY c."lastActivityAt" DESC
      LIMIT 10`;
  }

  private async eventLeg(userId: string, email: string) {
    const now = Date.now();
    const rows = await this.prisma.$queryRaw<Array<{
      id: string; title: string; location: string | null; startAt: Date; endAt: Date;
    }>>`
      SELECT e."id", e."title", e."location", e."startAt", e."endAt"
      FROM "calendar_events" e
      WHERE e."userId" = ${userId}
        AND e."startAt" BETWEEN ${new Date(now)} AND ${new Date(now + EVENT_LOOKAHEAD_DAYS * DAY_MS)}
        AND (lower(coalesce(e."organizer", '')) = ${email}
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(e."attendees") a
                        WHERE lower(a->>'email') = ${email}))
      ORDER BY e."startAt" ASC
      LIMIT 5`;
    return rows.map((e) => {
      const when = `${e.startAt.toLocaleString()} – ${e.endAt.toLocaleString()}`;
      const context = [`Event: ${e.title}`, `When: ${when}`, `Where: ${e.location ?? ''}`].join('\n');
      const chatSource: Omit<ChatSource, 'alias'> = {
        type: 'event', id: e.id, title: e.title, date: e.startAt.toISOString(),
        meta: when, context, injectionSuspected: detectInjectionAttempt(context),
      };
      return { chatSource, dateObj: e.startAt, inbound: false, fromName: null };
    });
  }
}
```

> Check `extractEmailText`'s actual return contract in `packages/shared` before relying on `??` — if it returns `''` rather than `null` on empty, use `|| r.snippet` like `RetrievalService.assembleContexts` does.

Add `DossierService` to `chat.module.ts` `providers`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest dossier.service --verbose`
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/dossier.service.ts apps/api/src/chat/dossier.service.spec.ts apps/api/src/chat/chat.module.ts
git commit -m "feat(api): DossierService — relationship-brief context legs + prompt"
```

---

### Task 6: MeetingPrepService — prep pack preparation

**Files:**
- Create: `apps/api/src/chat/meeting-prep.service.ts`
- Modify: `apps/api/src/chat/chat.module.ts` (provider)
- Test: `apps/api/src/chat/meeting-prep.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `RetrievalService.retrieve(userId, userEmail, question, scope)` (existing), shared helpers as in Task 5. Returns the same `PreparedGeneration` shape (import it from `./dossier.service`).
- Produces:

```ts
// MeetingPrepService
async prepare(userId: string, eventId: string): Promise<PreparedGeneration>  // kind: 'meeting_prep'
```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/chat/meeting-prep.service.spec.ts`:

```ts
import { NotFoundException } from '@nestjs/common';
import { MeetingPrepService } from './meeting-prep.service';

const EVENT = {
  id: 'e1', title: 'Budget review', description: 'Q3 numbers', location: 'Room 2',
  organizer: 'me@risa.gov.rw', startAt: new Date('2026-09-08T08:00:00Z'), endAt: new Date('2026-09-08T09:00:00Z'),
  updatedAt: new Date('2026-09-05T00:00:00Z'),
  attendees: [{ email: 'me@risa.gov.rw' }, { email: 'JD@gov.rw', name: 'J D' }, { email: 'ak@gov.rw' }],
  linkedMessageId: null,
};

function makeDeps() {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ email: 'me@risa.gov.rw' }) },
    calendarEvent: { findFirst: jest.fn().mockResolvedValue(EVENT) },
    message: { findFirst: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  } as any;
  const retrieval = { retrieve: jest.fn().mockResolvedValue({ sources: [], degraded: { vector: false, keyword: false, docs: false, calendar: false } }) } as any;
  return { prisma, retrieval };
}

describe('MeetingPrepService.prepare', () => {
  it('404s on an event that is missing or not the caller’s — before any retrieval', async () => {
    const { prisma, retrieval } = makeDeps();
    prisma.calendarEvent.findFirst.mockResolvedValue(null);
    await expect(new MeetingPrepService(prisma, retrieval).prepare('u1', 'nope'))
      .rejects.toThrow(NotFoundException);
    expect(retrieval.retrieve).not.toHaveBeenCalled();
  });

  it('always includes the event itself as the first source and excludes self from attendees', async () => {
    const { prisma, retrieval } = makeDeps();
    const p = await new MeetingPrepService(prisma, retrieval).prepare('u1', 'e1');
    expect(p.kind).toBe('meeting_prep');
    expect(p.targetKey).toBe('e1');
    expect(p.sources[0].type).toBe('event');
    // attendee mail leg queried with lowercased non-self emails
    const sqlCalls = prisma.$queryRaw.mock.calls.flat().map(String).join(' ');
    expect(sqlCalls).not.toContain('me@risa.gov.rw');
  });

  it('runs the retrieval legs scoped to mail+doc and folds degraded flags', async () => {
    const { prisma, retrieval } = makeDeps();
    retrieval.retrieve.mockRejectedValue(new Error('embed down'));
    const p = await new MeetingPrepService(prisma, retrieval).prepare('u1', 'e1');
    expect(retrieval.retrieve).toHaveBeenCalledWith('u1', 'me@risa.gov.rw', 'Budget review Q3 numbers', { types: ['mail', 'doc'] });
    expect(p.degraded.retrieval).toBe(true);
    expect(p.upstreamBody).not.toBeNull(); // event source alone still generates
  });

  it('dedupes a retrieval hit that is already an attendee-mail source', async () => {
    const { prisma, retrieval } = makeDeps();
    prisma.$queryRaw.mockResolvedValueOnce([{ // attendee mail leg
      id: 'm1', subject: 's', snippet: 'x', bodyText: 'b', bodyHtml: null,
      fromEmail: 'jd@gov.rw', fromName: null, receivedAt: new Date('2026-09-04T00:00:00Z'),
      gist: null, cardFlag: null,
    }]).mockResolvedValue([]);
    retrieval.retrieve.mockResolvedValue({
      sources: [{ type: 'mail', id: 'm1', title: 's', fromEmail: 'jd@gov.rw', fromName: null,
                  date: new Date('2026-09-04T00:00:00Z'), meta: null, context: 'b', injectionSuspected: false }],
      degraded: { vector: false, keyword: false, docs: false, calendar: false },
    });
    const p = await new MeetingPrepService(prisma, retrieval).prepare('u1', 'e1');
    expect(p.sources.filter((s) => s.id === 'm1')).toHaveLength(1);
  });

  it('anchor = max(event.updatedAt, newest mail source)', async () => {
    const { prisma, retrieval } = makeDeps();
    prisma.$queryRaw.mockResolvedValueOnce([{
      id: 'm1', subject: 's', snippet: 'x', bodyText: 'b', bodyHtml: null,
      fromEmail: 'jd@gov.rw', fromName: null, receivedAt: new Date('2026-09-06T07:00:00Z'),
      gist: null, cardFlag: null,
    }]).mockResolvedValue([]);
    const p = await new MeetingPrepService(prisma, retrieval).prepare('u1', 'e1');
    expect(p.sourceAnchor).toEqual(new Date('2026-09-06T07:00:00Z'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest meeting-prep --verbose`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/api/src/chat/meeting-prep.service.ts`:

```ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  buildGenerationPrompt, clampText, detectInjectionAttempt, extractEmailText,
  fenceUntrusted, neutralizeMarkers, type ChatSource,
} from '@email-client/shared';
import { ChatRequestDto } from '../ai/dto/chat.dto';
import { PrismaService } from '../prisma/prisma.service';
import { RetrievalService } from './retrieval.service';
import { NO_DOSSIER_DATA_REPLY, type PreparedGeneration } from './dossier.service';

const MAX_ATTENDEES = 6;
const MAIL_PER_ATTENDEE = 5;
const MAIL_TOTAL_CAP = 20;
const MAX_SOURCES = 14;
const PER_SOURCE_MAX_CHARS = 800;

@Injectable()
export class MeetingPrepService {
  private readonly logger = new Logger(MeetingPrepService.name);
  readonly chatModel = process.env.CHAT_MODEL ?? 'qwen3-30b-16k:latest';

  constructor(
    private readonly prisma: PrismaService,
    private readonly retrieval: RetrievalService,
  ) {}

  async prepare(userId: string, eventId: string): Promise<PreparedGeneration> {
    // Ownership FIRST — before any retrieval or mail queries; the controller
    // calls prepare() before flushing SSE headers so this is a clean 404.
    const event = await this.prisma.calendarEvent.findFirst({ where: { id: eventId, userId } });
    if (!event) throw new NotFoundException('event not found');

    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    const myEmail = me?.email?.toLowerCase() ?? '';
    const attendees = (Array.isArray(event.attendees) ? (event.attendees as Array<{ email?: string; name?: string }>) : [])
      .map((a) => ({ email: a?.email?.toLowerCase() ?? '', name: a?.name ?? null }))
      .filter((a) => a.email && a.email !== myEmail)
      .slice(0, MAX_ATTENDEES);
    const attendeeEmails = attendees.map((a) => a.email);

    const question = [event.title, event.description ?? ''].join(' ').trim();

    const [mailLeg, commitmentLeg, retrievalLeg, linkedLeg] = await Promise.allSettled([
      attendeeEmails.length ? this.attendeeMailLeg(userId, attendeeEmails) : Promise.resolve([]),
      attendeeEmails.length ? this.commitmentLeg(userId, attendeeEmails) : Promise.resolve([]),
      this.retrieval.retrieve(userId, me?.email ?? '', question, { types: ['mail', 'doc'] }),
      event.linkedMessageId ? this.linkedMessageLeg(userId, event.linkedMessageId) : Promise.resolve(null),
    ]);
    const degraded = {
      mail: mailLeg.status === 'rejected',
      commitments: commitmentLeg.status === 'rejected',
      retrieval: retrievalLeg.status === 'rejected',
      linked: linkedLeg.status === 'rejected',
    };
    for (const [name, leg] of Object.entries({ mail: mailLeg, commitments: commitmentLeg, retrieval: retrievalLeg, linked: linkedLeg })) {
      if (leg.status === 'rejected') this.logger.warn(`prep ${name} leg failed: ${(leg as PromiseRejectedResult).reason?.message}`);
    }

    // Assemble: event first (deterministic), then linked mail, attendee mail,
    // then retrieval hits — first occurrence of a (type,id) wins.
    const eventSource = this.eventSource(event);
    const pool: Array<Omit<ChatSource, 'alias'> & { dateObj: Date }> = [eventSource];
    if (linkedLeg.status === 'fulfilled' && linkedLeg.value) pool.push(linkedLeg.value);
    if (mailLeg.status === 'fulfilled') pool.push(...mailLeg.value);
    if (retrievalLeg.status === 'fulfilled') {
      pool.push(...retrievalLeg.value.sources.map((s) => ({
        type: s.type, id: s.id, title: s.title, fromEmail: s.fromEmail, fromName: s.fromName,
        date: s.date.toISOString(), meta: s.meta ?? null,
        context: s.context.slice(0, PER_SOURCE_MAX_CHARS),
        injectionSuspected: s.injectionSuspected, dateObj: s.date,
      })));
    }
    const seen = new Set<string>();
    const deduped = pool.filter((s) => {
      const key = `${s.type}:${s.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, MAX_SOURCES);

    const internal: ChatSource[] = deduped.map((s, i) => ({ ...s, alias: `s${i + 1}` }));

    const newestMail = deduped.filter((s) => s.type === 'mail')
      .reduce<Date | null>((acc, s) => (!acc || s.dateObj > acc ? s.dateObj : acc), null);
    const sourceAnchor = newestMail && newestMail > event.updatedAt ? newestMail : event.updatedAt;

    const commitments = commitmentLeg.status === 'fulfilled' ? commitmentLeg.value : [];
    const extra = commitments.length
      ? fenceUntrusted('TRACKER', commitments
          .map((c) => `- [${c.type}] ${neutralizeMarkers(c.text)}${c.dueHint ? ` (due hint: ${neutralizeMarkers(c.dueHint)})` : ''}`)
          .join('\n'))
      : undefined;

    const subject = `${event.title} — ${event.startAt.toLocaleString()}`;
    const system = buildGenerationPrompt('meeting_prep', subject, internal, extra);

    return {
      kind: 'meeting_prep',
      targetKey: eventId,
      sources: internal.map((s) => ({
        alias: s.alias, type: s.type, id: s.id, title: s.title,
        fromEmail: s.fromEmail, fromName: s.fromName, date: s.date,
        meta: s.meta, injectionSuspected: s.injectionSuspected,
        snippet: s.context.slice(0, 160),
      })),
      degraded,
      upstreamBody: {
        model: this.chatModel,
        messages: [
          { role: 'system' as const, content: system },
          { role: 'user' as const, content: clampText('Write the meeting prep pack now.', 2000) },
        ],
        stream: true,
        temperature: 0.2,
        max_tokens: 900,
      } as ChatRequestDto,
      fallbackReply: null, // the event source always exists — there is never a zero-source prep
      sourceAnchor,
    };
  }

  private eventSource(event: {
    id: string; title: string; description: string | null; location: string | null;
    organizer: string | null; attendees: unknown; startAt: Date; endAt: Date;
  }): Omit<ChatSource, 'alias'> & { dateObj: Date } {
    const when = `${event.startAt.toLocaleString()} – ${event.endAt.toLocaleString()}`;
    const attendees = Array.isArray(event.attendees)
      ? (event.attendees as Array<{ email?: string; name?: string }>)
          .map((a) => (a?.name ? `${a.name} <${a.email ?? ''}>` : a?.email ?? '')).filter(Boolean).join(', ')
      : '';
    const context = [
      `Event: ${event.title}`, `When: ${when}`, `Where: ${event.location ?? ''}`,
      `Organizer: ${event.organizer ?? ''}`, `Attendees: ${attendees}`,
      `Notes: ${(event.description ?? '').slice(0, 400)}`,
    ].join('\n');
    return {
      type: 'event', id: event.id, title: event.title, date: event.startAt.toISOString(),
      meta: when, context, injectionSuspected: detectInjectionAttempt(context), dateObj: event.startAt,
    };
  }

  private async attendeeMailLeg(userId: string, emails: string[]) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string; subject: string | null; snippet: string | null;
      bodyText: string | null; bodyHtml: string | null;
      fromEmail: string; fromName: string | null; receivedAt: Date;
      gist: string | null; cardFlag: boolean | null; rn: number;
    }>>`
      SELECT * FROM (
        SELECT m."id", m."subject", m."snippet", m."bodyText", m."bodyHtml",
               m."fromEmail", m."fromName", m."receivedAt",
               c."gist", c."injectionSuspected" AS "cardFlag",
               row_number() OVER (PARTITION BY lower(m."fromEmail") ORDER BY m."receivedAt" DESC) AS rn
        FROM "messages" m
        LEFT JOIN "message_cards" c ON c."messageId" = m."id" AND c."failed" = false
        WHERE m."userId" = ${userId} AND m."isDraft" = false
          AND lower(m."fromEmail") = ANY(${emails}::text[])
      ) ranked
      WHERE ranked.rn <= ${MAIL_PER_ATTENDEE}
      ORDER BY ranked."receivedAt" DESC
      LIMIT ${MAIL_TOTAL_CAP}`;
    return rows.map((r) => {
      const context = (
        r.gist ??
        extractEmailText({ bodyText: r.bodyText, bodyHtml: r.bodyHtml }, { maxChars: PER_SOURCE_MAX_CHARS }) ??
        r.snippet ?? ''
      ).slice(0, PER_SOURCE_MAX_CHARS);
      return {
        type: 'mail' as const, id: r.id, title: r.subject,
        fromEmail: r.fromEmail, fromName: r.fromName, date: r.receivedAt.toISOString(),
        meta: null, context,
        injectionSuspected: (r.cardFlag ?? false) || detectInjectionAttempt(context),
        dateObj: r.receivedAt,
      };
    }).filter((s) => s.context.length > 0);
  }

  private async commitmentLeg(userId: string, emails: string[]) {
    return this.prisma.$queryRaw<Array<{ type: string; text: string; dueHint: string | null }>>`
      SELECT c."type", c."text", c."dueHint"
      FROM "commitments" c
      JOIN "messages" m ON m."id" = c."messageId"
      WHERE c."userId" = ${userId} AND c."status" = 'open'
        AND (lower(m."fromEmail") = ANY(${emails}::text[])
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(m."toRecipients") r
                        WHERE lower(r->>'email') = ANY(${emails}::text[])))
      ORDER BY c."lastActivityAt" DESC
      LIMIT 10`;
  }

  private async linkedMessageLeg(userId: string, messageId: string) {
    const m = await this.prisma.message.findFirst({
      where: { id: messageId, userId },
      select: { id: true, subject: true, snippet: true, bodyText: true, bodyHtml: true, fromEmail: true, fromName: true, receivedAt: true },
    });
    if (!m) return null;
    const context = (
      extractEmailText({ bodyText: m.bodyText, bodyHtml: m.bodyHtml }, { maxChars: PER_SOURCE_MAX_CHARS }) ??
      m.snippet ?? ''
    ).slice(0, PER_SOURCE_MAX_CHARS);
    if (!context) return null;
    return {
      type: 'mail' as const, id: m.id, title: m.subject,
      fromEmail: m.fromEmail, fromName: m.fromName, date: m.receivedAt.toISOString(),
      meta: null, context, injectionSuspected: detectInjectionAttempt(context), dateObj: m.receivedAt,
    };
  }
}
```

(The `NO_DOSSIER_DATA_REPLY` import is unused here — remove it if the linter complains; it exists for the controller.)

Add `MeetingPrepService` to `chat.module.ts` `providers`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest meeting-prep --verbose`
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/meeting-prep.service.ts apps/api/src/chat/meeting-prep.service.spec.ts apps/api/src/chat/chat.module.ts
git commit -m "feat(api): MeetingPrepService — event-scoped prep-pack context assembly"
```

---

### Task 7: GenerationController — the four endpoints

**Files:**
- Create: `apps/api/src/chat/generation.controller.ts`, `apps/api/src/chat/dto/generation.dto.ts`
- Modify: `apps/api/src/chat/chat.module.ts` (controller)
- Test: `apps/api/src/chat/generation.controller.spec.ts`

**Interfaces:**
- Consumes: `DossierService.prepare`, `MeetingPrepService.prepare`, `GenerationCacheService.get/upsert`, `AiService.upstream(body, signal)` (existing), `extractSseText` from `@email-client/shared`.
- Produces routes (all `JwtAuthGuard`, `@Throttle({ default: { limit: 10, ttl: 60_000 } })` — generations are heavier than asks):
  - `POST /ai/dossier` `{email}` → SSE: `event: sources` frame `{sources, degraded}`, then deltas; caches on completion.
  - `GET /ai/dossier?email=` → `{ cached: CachedGeneration | null }`
  - `POST /ai/meeting-prep` `{eventId}` → same SSE shape; caches on completion.
  - `GET /ai/meeting-prep?eventId=` → `{ cached: CachedGeneration | null }`

- [ ] **Step 1: Write the DTOs**

`apps/api/src/chat/dto/generation.dto.ts`:

```ts
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class DossierRequestDto {
  @IsEmail()
  email!: string;
}

export class MeetingPrepRequestDto {
  @IsString()
  @IsNotEmpty()
  eventId!: string;
}
```

(The GET variants reuse these same classes via `@Query()`.)

- [ ] **Step 2: Write the failing controller tests**

`apps/api/src/chat/generation.controller.spec.ts` — mirror the `res` mocking pattern in `apps/api/src/chat/chat.controller.spec.ts` (read it first; reuse its mock response factory). Cover:

```ts
// Test list (write these with the existing spec's helpers):
// 1. POST /ai/dossier: prepare() rejects (own email BadRequest) → error propagates, no SSE headers written.
// 2. POST /ai/dossier happy path: writes `event: sources` first, pipes upstream bytes,
//    and after [DONE] calls cache.upsert('u1','dossier','jd@gov.rw', {content:'Hello', …})
//    — feed a mock upstream body of two delta frames + [DONE] and assert the upsert
//    content equals extractSseText of those frames.
// 3. POST fallback path (upstreamBody null): writes the fallbackReply delta + [DONE],
//    does NOT call aiService.upstream, does NOT call cache.upsert.
// 4. Client abort (res 'close' before upstream ends): no cache.upsert.
// 5. GET /ai/dossier returns { cached } straight from cache.get.
// 6. POST /ai/meeting-prep: prepare() NotFound → propagates before headers.
// 7. GET /ai/meeting-prep returns { cached: null } when cache.get resolves null.
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/api && npx jest generation.controller --verbose`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`apps/api/src/chat/generation.controller.ts`:

```ts
import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { extractSseText } from '@email-client/shared';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AiService } from '../ai/ai.service';
import { DossierService, type PreparedGeneration } from './dossier.service';
import { MeetingPrepService } from './meeting-prep.service';
import { GenerationCacheService, type CachedGeneration } from './generation-cache.service';
import { DossierRequestDto, MeetingPrepRequestDto } from './dto/generation.dto';

interface AuthenticatedRequest extends Request {
  user: { sub: string };
}

/**
 * Phase 3b one-shot generations: relationship dossier + meeting prep pack.
 * Same SSE protocol as /ai/ask (leading `event: sources`, then OpenAI-shaped
 * deltas). Unlike ask, the finished text is ALSO accumulated server-side and
 * upserted into ai_generations — the GET endpoints serve that cache with a
 * read-time stale flag. Preparation (incl. ownership/own-address checks) runs
 * BEFORE headers flush, so failures are ordinary JSON 4xx.
 */
@UseGuards(JwtAuthGuard)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
@Controller('ai')
export class GenerationController {
  constructor(
    private readonly dossier: DossierService,
    private readonly meetingPrep: MeetingPrepService,
    private readonly cache: GenerationCacheService,
    private readonly aiService: AiService,
  ) {}

  @Post('dossier')
  async streamDossier(
    @Req() req: AuthenticatedRequest, @Res() res: Response, @Body() body: DossierRequestDto,
  ): Promise<void> {
    const prepared = await this.dossier.prepare(req.user.sub, body.email);
    await this.stream(req.user.sub, res, prepared, this.dossier.chatModel);
  }

  @Get('dossier')
  async cachedDossier(
    @Req() req: AuthenticatedRequest, @Query() q: DossierRequestDto,
  ): Promise<{ cached: CachedGeneration | null }> {
    return { cached: await this.cache.get(req.user.sub, 'dossier', q.email.trim().toLowerCase()) };
  }

  @Post('meeting-prep')
  async streamMeetingPrep(
    @Req() req: AuthenticatedRequest, @Res() res: Response, @Body() body: MeetingPrepRequestDto,
  ): Promise<void> {
    const prepared = await this.meetingPrep.prepare(req.user.sub, body.eventId);
    await this.stream(req.user.sub, res, prepared, this.meetingPrep.chatModel);
  }

  @Get('meeting-prep')
  async cachedMeetingPrep(
    @Req() req: AuthenticatedRequest, @Query() q: MeetingPrepRequestDto,
  ): Promise<{ cached: CachedGeneration | null }> {
    return { cached: await this.cache.get(req.user.sub, 'meeting_prep', q.eventId) };
  }

  private async stream(userId: string, res: Response, prepared: PreparedGeneration, model: string): Promise<void> {
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    res.write(`event: sources\ndata: ${JSON.stringify({ sources: prepared.sources, degraded: prepared.degraded })}\n\n`);

    if (!prepared.upstreamBody) {
      // Nothing on file — reply without a model call and WITHOUT caching
      // (a later first-mail should produce a real brief, not serve this).
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: prepared.fallbackReply } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    let upstream: globalThis.Response;
    try {
      upstream = await this.aiService.upstream(prepared.upstreamBody, ac.signal);
    } catch (err: any) {
      if (ac.signal.aborted) { res.end(); return; }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `⚠ ${err?.message ?? 'AI backend error'}` } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (!upstream.body) { res.end(); return; }

    // Pipe bytes to the client verbatim while accumulating the same bytes —
    // the accumulated transcript is parsed once at the end for the cache.
    const decoder = new TextDecoder();
    let transcript = '';
    let completed = false;
    const reader = upstream.body.getReader();
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) { completed = true; break; }
        transcript += decoder.decode(value, { stream: true });
        if (!res.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      }
    } catch (err) {
      if (!ac.signal.aborted) throw err;
    } finally {
      res.end();
    }

    if (completed && !ac.signal.aborted) {
      const content = extractSseText(transcript).trim();
      if (content) {
        await this.cache.upsert(userId, prepared.kind, prepared.targetKey, {
          content, sources: prepared.sources, model, sourceAnchor: prepared.sourceAnchor,
        });
      }
    }
  }
}
```

Add `GenerationController` to `chat.module.ts` `controllers`.

- [ ] **Step 5: Run tests to verify they pass, full suite, commit**

Run: `cd apps/api && npx jest generation.controller --verbose && npx jest && npx tsc --noEmit`

```bash
git add apps/api/src/chat/generation.controller.ts apps/api/src/chat/generation.controller.spec.ts apps/api/src/chat/dto/generation.dto.ts apps/api/src/chat/chat.module.ts
git commit -m "feat(api): /ai/dossier + /ai/meeting-prep streaming endpoints with cache write-back"
```

---

### Task 8: Web — SSE client refactor, generation client, people store, api namespace

**Files:**
- Create: `apps/web/lib/ai/sse.ts`, `apps/web/lib/ai/generation.ts`, `apps/web/stores/people.store.ts`
- Modify: `apps/web/lib/ai/ask.ts` (delegate SSE parsing to `sse.ts` — public API unchanged), `apps/web/lib/api.ts` (add `people` namespace)
- Test: `apps/web/lib/ai/generation.test.ts`, `apps/web/stores/people.store.test.ts`

**Interfaces:**
- Consumes: `authedFetch` (`lib/authed-fetch`), `AIHttpError` (`lib/ai/client`), `AskSource`/`AskTurn` types (`lib/ai/ask`), `useAskStore` (`stores/ask.store`), `request` helper in `lib/api.ts`, `PersonDossier` shape from Task 2 (declare the TS mirror locally in `lib/api.ts`).
- Produces:

```ts
// lib/ai/sse.ts
export async function readSse(res: Response, opts: {
  onSources?: (sources: any[], degraded: any) => void;
  onChunk: (delta: string) => void;
}): Promise<string>  // full text; identical semantics to streamAsk's old loop

// lib/ai/generation.ts
export interface CachedGeneration { content: string; sources: AskSource[]; generatedAt: string; stale: boolean }
export type GenerationDegraded = Record<string, boolean>;
export async function streamDossier(email: string, opts: {
  onSources: (sources: AskSource[], degraded: GenerationDegraded) => void;
  onChunk: (delta: string) => void; signal?: AbortSignal;
}): Promise<string>
export async function streamMeetingPrep(eventId: string, opts: /* same */): Promise<string>
export async function getCachedDossier(email: string): Promise<CachedGeneration | null>
export async function getCachedMeetingPrep(eventId: string): Promise<CachedGeneration | null>

// stores/people.store.ts
export interface DossierTarget { email: string; name?: string | null }
interface PeopleState {
  open: boolean;
  target: DossierTarget | null;
  openDossier: (t: DossierTarget) => void; // lowercases email; closes the Ask panel (mutual exclusion)
  close: () => void;                        // open:false, target kept for exit animation-free simplicity? NO — clears target
}
export const usePeopleStore: /* zustand */;

// lib/api.ts
api.people = { dossier: (email: string) => Promise<PersonDossier> }
```

- [ ] **Step 1: Extract `readSse` from `ask.ts`**

Create `apps/web/lib/ai/sse.ts` containing the reader loop currently inside `streamAsk` (lines ~56–98 of `ask.ts`), generalized exactly as the interface above (an `event: sources` frame calls `onSources` when provided, otherwise is skipped). Rewrite `streamAsk`'s body to:

```ts
  const res = await authedFetch('/ai/ask', { /* unchanged */ });
  if (!res.ok || !res.body) { /* unchanged error block */ }
  return readSse(res, { onSources: opts.onSources, onChunk: opts.onChunk });
```

Run: `cd apps/web && npx vitest run lib/ai/ask.test.ts`
Expected: PASS unchanged — the refactor is behavior-preserving.

- [ ] **Step 2: Write the failing tests**

`apps/web/lib/ai/generation.test.ts` — copy the fetch-mocking approach from `lib/ai/ask.test.ts` (it mocks `authedFetch`; reuse its stream-response builder):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCachedDossier, streamDossier, streamMeetingPrep } from './generation';
import { authedFetch } from '../authed-fetch';

vi.mock('../authed-fetch', () => ({ authedFetch: vi.fn() }));
const mockFetch = vi.mocked(authedFetch);

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream({
    start(c) { frames.forEach((f) => c.enqueue(new TextEncoder().encode(f))); c.close(); },
  });
  return new Response(body, { status: 200 });
}

beforeEach(() => mockFetch.mockReset());

describe('streamDossier', () => {
  it('POSTs the email and surfaces sources + chunks', async () => {
    mockFetch.mockResolvedValue(sseResponse([
      'event: sources\ndata: {"sources":[{"alias":"s1"}],"degraded":{"mail":false}}\n\n',
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n',
    ]));
    const onSources = vi.fn(); const onChunk = vi.fn();
    const full = await streamDossier('JD@gov.rw', { onSources, onChunk });
    expect(mockFetch).toHaveBeenCalledWith('/ai/dossier', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ email: 'jd@gov.rw' }),
    }));
    expect(onSources).toHaveBeenCalledWith([{ alias: 's1' }], { mail: false });
    expect(full).toBe('Hi');
  });

  it('throws AIHttpError with the server message on 4xx', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ message: 'cannot open a dossier on yourself' }), { status: 400 }));
    await expect(streamDossier('me@x.rw', { onSources: vi.fn(), onChunk: vi.fn() }))
      .rejects.toThrow(/yourself/);
  });
});

describe('streamMeetingPrep', () => {
  it('POSTs the eventId', async () => {
    mockFetch.mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    await streamMeetingPrep('e1', { onSources: vi.fn(), onChunk: vi.fn() });
    expect(mockFetch).toHaveBeenCalledWith('/ai/meeting-prep', expect.objectContaining({
      body: JSON.stringify({ eventId: 'e1' }),
    }));
  });
});

describe('getCachedDossier', () => {
  it('GETs with the encoded lowercased email and unwraps { cached }', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ cached: { content: 'x', sources: [], generatedAt: 'g', stale: true } }), { status: 200 }));
    const got = await getCachedDossier('JD+x@gov.rw');
    expect(mockFetch).toHaveBeenCalledWith('/ai/dossier?email=jd%2Bx%40gov.rw');
    expect(got?.stale).toBe(true);
  });
});
```

`apps/web/stores/people.store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { usePeopleStore } from './people.store';
import { useAskStore } from './ask.store';

beforeEach(() => {
  usePeopleStore.setState({ open: false, target: null });
  useAskStore.getState().close();
});

describe('people store', () => {
  it('openDossier lowercases the email and opens', () => {
    usePeopleStore.getState().openDossier({ email: 'JD@Gov.RW', name: 'J D' });
    expect(usePeopleStore.getState()).toMatchObject({ open: true, target: { email: 'jd@gov.rw', name: 'J D' } });
  });

  it('openDossier closes the Ask panel (mutual exclusion, dossier side)', () => {
    useAskStore.getState().openAsk();
    usePeopleStore.getState().openDossier({ email: 'a@b.c' });
    expect(useAskStore.getState().open).toBe(false);
  });

  it('close clears the target', () => {
    usePeopleStore.getState().openDossier({ email: 'a@b.c' });
    usePeopleStore.getState().close();
    expect(usePeopleStore.getState()).toMatchObject({ open: false, target: null });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run lib/ai/generation.test.ts stores/people.store.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`apps/web/lib/ai/generation.ts`:

```ts
/**
 * Clients for the phase 3b one-shot generations: POST /ai/dossier and
 * POST /ai/meeting-prep (same SSE protocol as /ai/ask — leading
 * `event: sources`, then deltas) plus their cached GET companions.
 */
import { authedFetch } from '../authed-fetch';
import { AIHttpError } from './client';
import type { AskSource } from './ask';
import { readSse } from './sse';

export interface CachedGeneration {
  content: string;
  sources: AskSource[];
  generatedAt: string; // ISO
  stale: boolean;
}

export type GenerationDegraded = Record<string, boolean>;

interface StreamOpts {
  onSources: (sources: AskSource[], degraded: GenerationDegraded) => void;
  onChunk: (delta: string) => void;
  signal?: AbortSignal;
}

async function streamGeneration(path: string, body: object, opts: StreamOpts): Promise<string> {
  const res = await authedFetch(path, { method: 'POST', body: JSON.stringify(body), signal: opts.signal });
  if (!res.ok || !res.body) {
    let message = `AI request failed (${res.status})`;
    try {
      const json = await res.json();
      message = `AI request failed (${res.status}): ${json?.message ?? res.statusText}`;
    } catch { /* stream body — keep default */ }
    throw new AIHttpError(message, res.status);
  }
  return readSse(res, {
    onSources: (sources, degraded) => opts.onSources(sources ?? [], degraded ?? {}),
    onChunk: opts.onChunk,
  });
}

export function streamDossier(email: string, opts: StreamOpts): Promise<string> {
  return streamGeneration('/ai/dossier', { email: email.trim().toLowerCase() }, opts);
}

export function streamMeetingPrep(eventId: string, opts: StreamOpts): Promise<string> {
  return streamGeneration('/ai/meeting-prep', { eventId }, opts);
}

async function getCached(path: string): Promise<CachedGeneration | null> {
  const res = await authedFetch(path);
  if (!res.ok) return null; // cache miss is never fatal — the panel just shows the generate button
  const json = await res.json().catch(() => null);
  return json?.cached ?? null;
}

export function getCachedDossier(email: string): Promise<CachedGeneration | null> {
  return getCached(`/ai/dossier?email=${encodeURIComponent(email.trim().toLowerCase())}`);
}

export function getCachedMeetingPrep(eventId: string): Promise<CachedGeneration | null> {
  return getCached(`/ai/meeting-prep?eventId=${encodeURIComponent(eventId)}`);
}
```

`apps/web/stores/people.store.ts`:

```ts
'use client';

import { create } from 'zustand';
import { useAskStore } from './ask.store';

export interface DossierTarget {
  email: string;
  /** Display-name hint from the click site (fromName / attendee name) — the facts fetch refines it. */
  name?: string | null;
}

/**
 * Person dossier panel state — single mount in the app layout, same pattern
 * as ask.store. The dossier and Ask panels are MUTUALLY EXCLUSIVE when
 * docked (Bruce, 2026-09-06): opening one closes the other. This side closes
 * Ask directly; the reverse direction lives in PersonDossierPanel's effect
 * (watching ask.open) to avoid a store import cycle.
 */
interface PeopleState {
  open: boolean;
  target: DossierTarget | null;
  openDossier: (t: DossierTarget) => void;
  close: () => void;
}

export const usePeopleStore = create<PeopleState>((set) => ({
  open: false,
  target: null,
  openDossier: (t) => {
    useAskStore.getState().close();
    set({ open: true, target: { ...t, email: t.email.trim().toLowerCase() } });
  },
  close: () => set({ open: false, target: null }),
}));
```

In `apps/web/lib/api.ts`, add a `people` namespace beside `contacts` (mirror the `request`/`USE_MOCK` pattern of the surrounding namespaces), with the `PersonDossier` TS interface mirroring Task 2's response verbatim:

```ts
  people: {
    /** Deterministic per-person dossier facts — GET /people/dossier. */
    dossier: (email: string): Promise<PersonDossier> => {
      if (USE_MOCK) return delay(EMPTY_DOSSIER);
      return request<PersonDossier>(`/people/dossier?email=${encodeURIComponent(email.trim().toLowerCase())}`);
    },
  },
```

(Define `PersonDossier` and an `EMPTY_DOSSIER` constant — all-empty arrays, zeroed profile — near the other exported types in that file.)

- [ ] **Step 5: Run tests to verify they pass, commit**

Run: `cd apps/web && npx vitest run lib/ai stores && npx tsc --noEmit`

```bash
git add apps/web/lib/ai/sse.ts apps/web/lib/ai/generation.ts apps/web/lib/ai/generation.test.ts apps/web/lib/ai/ask.ts apps/web/stores/people.store.ts apps/web/stores/people.store.test.ts apps/web/lib/api.ts
git commit -m "feat(web): people store + dossier/meeting-prep streaming clients (shared SSE reader)"
```

---

### Task 9: Web — GenerationAnswer + PersonDossierPanel + mount + mail-page reservation

**Files:**
- Create: `apps/web/components/ai/GenerationAnswer.tsx`, `apps/web/components/people/PersonDossierPanel.tsx`
- Modify: `apps/web/app/(app)/layout.tsx` (mount panel after `<AskLauncher />`), `apps/web/app/(app)/mail/page.tsx` (line ~1241: reservation also honors the dossier panel)
- Test: `apps/web/components/ai/GenerationAnswer.test.tsx`, `apps/web/components/people/PersonDossierPanel.test.tsx`

**Interfaces:**
- Consumes: `usePeopleStore`, `api.people.dossier`, `getCachedDossier`, `streamDossier` (Task 8), `splitByCitations` from `@email-client/shared`, `sourceHref` (`lib/ai/sourceNav`), `useAskStore` (`setOpenTarget` for same-route opens + mutual exclusion), `useAIStore` (`enabled` gate), `MailAvatar`/`getInitials` (`components/mail/MailAvatar`).
- Produces:

```tsx
// components/ai/GenerationAnswer.tsx — shared by the dossier panel (this task) and the prep view (Task 10)
export function GenerationAnswer(props: {
  content: string;                 // finished or in-flight text
  sources: AskSource[];
  streaming?: boolean;
  onSourceClick: (s: { type: AskSourceType; id: string }) => void;
}): JSX.Element
// Renders splitByCitations(content, validAliases) — text segments as
// whitespace-pre-wrap prose, cite segments as inline typed chips (reuse the
// chip styling classes from AskPanel — read AskPanel.tsx and copy its chip
// markup); an amber "possible prompt-injection" banner when any
// source.injectionSuspected (copy AskPanel's banner markup); a source rail
// of typed chips below the text.

// components/people/PersonDossierPanel.tsx
export default function PersonDossierPanel(): JSX.Element | null
```

- [ ] **Step 1: Write the failing GenerationAnswer tests**

`apps/web/components/ai/GenerationAnswer.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { GenerationAnswer } from './GenerationAnswer';

const SOURCES = [
  { alias: 's1', type: 'mail' as const, id: 'm1', title: 'Budget', fromEmail: 'jd@gov.rw',
    fromName: 'J D', date: '2026-09-01T00:00:00Z', meta: null, injectionSuspected: false, snippet: 'x' },
];

describe('GenerationAnswer', () => {
  it('renders cite segments as chips and fires onSourceClick', () => {
    const onClick = vi.fn();
    render(<GenerationAnswer content="See [s1] for detail." sources={SOURCES} onSourceClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: /Budget/ }));
    expect(onClick).toHaveBeenCalledWith({ type: 'mail', id: 'm1' });
  });

  it('never renders a chip for an alias the server did not vouch for', () => {
    render(<GenerationAnswer content="Fake [s9] citation." sources={SOURCES} onSourceClick={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /s9/ })).toBeNull();
    expect(screen.getByText(/\[s9\]/)).toBeTruthy(); // stays literal text
  });

  it('shows the injection banner when any source is flagged', () => {
    render(<GenerationAnswer content="x" sources={[{ ...SOURCES[0], injectionSuspected: true }]} onSourceClick={vi.fn()} />);
    expect(screen.getByText(/injection/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Write the failing PersonDossierPanel tests**

`apps/web/components/people/PersonDossierPanel.test.tsx` — mock `lib/api` (`api.people.dossier`), `lib/ai/generation` (`getCachedDossier`, `streamDossier`), and `next/navigation` (`useRouter`, `usePathname`); drive `usePeopleStore` directly:

```tsx
// Test list:
// 1. Renders nothing when store.open is false.
// 2. On open: calls api.people.dossier with the target email; renders profile
//    name, "Recent conversations", "Open loops", "Shared events", "Shared docs"
//    section content from the mocked PersonDossier.
// 3. Cached narrative present (getCachedDossier resolves {stale:true,…}):
//    renders the content + a "stale" badge + a Regenerate button; NO
//    "Summarize relationship" button.
// 4. No cached narrative: renders the "Summarize relationship" button;
//    clicking it calls streamDossier with the email.
// 5. Ask-panel mutual exclusion (panel side): with the dossier open, calling
//    useAskStore.getState().openAsk() closes the dossier (effect watching ask.open).
// 6. Conversation row click on a non-mail route calls router.push('/mail?open=<messageId>').
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run components/ai/GenerationAnswer.test.tsx components/people`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `GenerationAnswer`**

Read `apps/web/components/ai/AskPanel.tsx` first and lift its citation-chip markup, source-chip icons (mail/doc/event), and amber injection-banner block into `GenerationAnswer.tsx` (a pure presentational component — no store access). Core render logic:

```tsx
const valid = new Set(sources.map((s) => s.alias));
const segments = splitByCitations(content, valid);
// map segments: {kind:'text'} → <span className="whitespace-pre-wrap">, {kind:'cite'} →
// chip button labeled by the source's title/type icon, onClick={() => onSourceClick(src)}
```

Deviation guard: do NOT delete or restructure AskPanel's own rendering in this task — copy, don't extract. (AskPanel's answer rendering is interwoven with turn state; unifying them is follow-up debt, noted in the plan's final task.)

- [ ] **Step 5: Implement `PersonDossierPanel`**

`apps/web/components/people/PersonDossierPanel.tsx`, structure (follow AskPanel's docking classes verbatim — `fixed inset-y-0 right-0 z-[41] w-full max-w-[420px]` plus its border/background classes):

```tsx
'use client';
// State: facts (PersonDossier | null), factsLoading, factsError,
//        narrative { content, sources, generatedAt, stale } | null,
//        streaming buffer + AbortController ref.
// Effects:
//  1. open/target.email change → reset state; api.people.dossier(email) → facts;
//     getCachedDossier(email) → narrative. Both fire-and-forget with mounted guard.
//  2. Mutual exclusion (ask side): const askOpen = useAskStore((s) => s.open);
//     useEffect(() => { if (askOpen) usePeopleStore.getState().close(); }, [askOpen]);
//  3. Escape key closes.
// Abort any in-flight stream on close/unmount (AbortController in a ref).
// Header: MailAvatar(name,email) + display name (facts.profile.name ?? target.name ?? email)
//         + last-interaction line + X close button.
// Sections (each a labeled group, skipped when empty):
//  - Recent conversations: subject + snippet + relative date + in/out arrow icon;
//    click → openSource('mail', messageId).
//  - Open loops: two sub-lists — "You promised" (type promised) / "Waiting on them"
//    (type waiting); click → openSource('mail', c.messageId).
//  - Shared events: title + date, upcoming first; click → openSource('event', id).
//  - Shared docs: emoji + title + direction tag; click → openSource('doc', id).
// AI block at the bottom:
//  - narrative null + not streaming → "Summarize relationship" button → start stream.
//  - streaming → <GenerationAnswer content={buffer} sources={streamSources} streaming />.
//  - narrative set → <GenerationAnswer …/> + "Generated <relative time>" line +
//    stale && <amber "Stale — newer mail since" badge> + Regenerate button (re-runs the stream).
// openSource(type, id): same-route → useAskStore.getState().setOpenTarget({type, id})
//   (the mail/docs/calendar pages already consume this signal); otherwise
//   router.push(sourceHref({type, id})). Mirrors AskPanel's chip navigation.
// Stream start: const ac = new AbortController();
//   streamDossier(email, { onSources: setStreamSources, onChunk: (d) => setBuffer((b) => b + d), signal: ac.signal })
//     .then((full) => setNarrative({ content: full, sources: streamSources, generatedAt: new Date().toISOString(), stale: false }))
//     .catch((e) => { if (!ac.signal.aborted) setStreamError(String(e?.message ?? e)); })
//     .finally(() => setStreaming(false));
```

Mount in `apps/web/app/(app)/layout.tsx` directly after `<AskLauncher />`:

```tsx
import PersonDossierPanel from '@/components/people/PersonDossierPanel';
…
      <AskLauncher />
      <PersonDossierPanel />
```

- [ ] **Step 6: Mail-page reservation**

In `apps/web/app/(app)/mail/page.tsx` at the `askDocked && 'xl:pr-[420px]'` line (~1241): add `const dossierOpen = usePeopleStore((s) => s.open);` at the top of the component and change the condition to `(askDocked || dossierOpen) && 'xl:pr-[420px]'`. (Only one can be open at a time — mutual exclusion — so a single reservation width is always right.)

- [ ] **Step 7: Run tests to verify they pass, full suite, commit**

Run: `cd apps/web && npx vitest run && npx tsc --noEmit`

```bash
git add apps/web/components/ai/GenerationAnswer.tsx apps/web/components/ai/GenerationAnswer.test.tsx apps/web/components/people "apps/web/app/(app)/layout.tsx" "apps/web/app/(app)/mail/page.tsx"
git commit -m "feat(web): PersonDossierPanel — docked dossier with facts + streamed narrative"
```

---

### Task 10: Web — entry points + meeting prep view

**Files:**
- Modify: `apps/web/components/mail/ThreadMessage.tsx` (both sender render sites, ~547 collapsed / ~640 expanded), `apps/web/components/mail/MailDetail.tsx` (sender header), `apps/web/app/(app)/calendar/page.tsx` (`EventDetailPanel`: organizer + attendee rows clickable; Prep section)
- Create: `apps/web/components/calendar/MeetingPrepView.tsx`
- Test: `apps/web/components/calendar/MeetingPrepView.test.tsx`

**Interfaces:**
- Consumes: `usePeopleStore.openDossier`, `useAIStore` `enabled`, `getCachedMeetingPrep` / `streamMeetingPrep` (Task 8), `GenerationAnswer` (Task 9), `useAskStore.setOpenTarget` + `sourceHref` for chip navigation.
- Produces:

```tsx
// components/calendar/MeetingPrepView.tsx
export function MeetingPrepView(props: { eventId: string }): JSX.Element
```

- [ ] **Step 1: Write the failing MeetingPrepView tests**

`apps/web/components/calendar/MeetingPrepView.test.tsx` — mock `lib/ai/generation` and `next/navigation`:

```tsx
// Test list:
// 1. Cached pack exists (getCachedMeetingPrep resolves fresh) → content renders
//    immediately, "Regenerate" button present, no "Prep" generate button.
// 2. Cached pack stale → stale badge + Regenerate.
// 3. No cache → "Prepare me for this meeting" button; click calls
//    streamMeetingPrep('e1', …) and renders streamed chunks.
// 4. eventId prop change resets state and refetches the cache.
// 5. Stream error (mock rejects) → readable error line, button returns.
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run components/calendar/MeetingPrepView.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `MeetingPrepView`**

Same state machine as the dossier AI block (cache fetch on mount keyed by `eventId`, generate/regenerate button, streaming buffer, abort on unmount), rendering through `GenerationAnswer`. Chip navigation: same-route event chips go through `useAskStore.getState().setOpenTarget`, everything else `router.push(sourceHref(...))` — identical helper logic to PersonDossierPanel (copy the ~6-line `openSource` function; keep the copies textually identical).

Visual shell: a bordered section styled like the panel's other blocks (`text-[0.625rem] uppercase tracking-wider text-muted-foreground/40` section label — match `EventDetailPanel`'s existing label classes), label "Meeting prep", with a `BookOpenCheck` lucide icon on the generate button and `Loader2` spin while streaming (per-feature-icon convention from phase 2).

- [ ] **Step 4: Wire into `EventDetailPanel`**

In `apps/web/app/(app)/calendar/page.tsx`:
- Inside `EventDetailPanel`, after the Attendees section, render `{aiEnabled && <MeetingPrepView eventId={event.id} />}` (`const aiEnabled = useAIStore((s) => s.enabled);`).
- Organizer line (~1781) and each attendee row (~1808): when the email differs from `currentUserEmail`, wrap the name/email in a button → `usePeopleStore.getState().openDossier({ email: a.email, name: a.name })`, `title="Open dossier"`, `className` adding `hover:underline cursor-pointer text-left`. Keep the existing ptst badge rendering untouched.

- [ ] **Step 5: Sender entry points in mail**

- `ThreadMessage.tsx`: at both render sites, wrap the existing sender display-name text (NOT the whole header row — reply/expand clicks must keep working) in a `<button type="button" onClick={(e) => { e.stopPropagation(); usePeopleStore.getState().openDossier({ email: message.fromEmail, name: message.fromName }); }} className="hover:underline text-left" title="Open dossier">`. Gate on `useAIStore((s) => s.enabled)` — plain `<span>` when AI is off.
- `MailDetail.tsx`: same treatment on its sender name header (find the `fromName ?? fromEmail` display).

- [ ] **Step 6: Run the full web suite + typecheck**

Run: `cd apps/web && npx vitest run && npx tsc --noEmit`
Expected: all green (existing ThreadMessage tests must still pass — the button wraps only the name text).

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/calendar/MeetingPrepView.tsx apps/web/components/calendar/MeetingPrepView.test.tsx apps/web/components/mail/ThreadMessage.tsx apps/web/components/mail/MailDetail.tsx "apps/web/app/(app)/calendar/page.tsx"
git commit -m "feat(web): dossier entry points (sender/attendee) + meeting prep view on event panel"
```

---

### Task 11: Final verification gates

**Files:** none new — verification + any fix-ups.

- [ ] **Step 1: Full test suites**

Run: `cd apps/api && npx jest` → expect 202+ passing, zero failures.
Run: `cd apps/web && npx vitest run` → expect 405+ passing, zero failures.

- [ ] **Step 2: Typechecks**

Run: `cd apps/api && npx tsc --noEmit && cd ../web && npx tsc --noEmit`

- [ ] **Step 3: Containerized builds (the real build gate — NOT local `next build`)**

Run: `scripts/build-web-154.sh` and the api build script beside it (check `scripts/` for the api equivalent used in phase 3a). For the api tarball, verify the prisma client survived bundling:
`tar -tzf <api tarball> | grep -c ".prisma/client"` — expect ~126 entries (guard with `find -maxdepth 6` semantics per phase 3a: the client lives at `.pnpm/<hash>/node_modules/.prisma/client/`).

- [ ] **Step 4: Record follow-up debt**

Append to the plan (or closing report): AskPanel/GenerationAnswer rendering duplication (chips + banner copied, not extracted); `openSource` helper duplicated between PersonDossierPanel and MeetingPrepView; prep staleness checks inbound mail only; `toRecipients` JSONB scans unindexed; DL addresses treated as a single person.

- [ ] **Step 5: Push**

```bash
git push origin ft-hyperscale
```

---

## Self-Review (completed)

- **Spec coverage:** migration (T1), people facts incl. all five sections (T2), cache table + staleness semantics (T1/T3), dossier stream + legs (T5), prep stream + ownership-before-retrieval + vector ACL reuse (T6), four endpoints + cache write-back + fallback (T7), store/client/mutual exclusion (T8), panel + entries + reservation (T9), prep view + attendee/sender entries (T10), gates + deploy prep (T11). Deploy itself (migrate + ship both VMs) is a separate operator step per the spec's deploy notes.
- **Type consistency:** `PreparedGeneration` defined once in `dossier.service.ts`, imported by T6/T7; `GenerationKind`/`CachedGeneration` defined once in `generation-cache.service.ts`; web `CachedGeneration` mirrors it; `readSse` consumed by both clients.
- **Placeholders:** none — every code step carries real code; the two "read the existing file first" notes (fence sentinel text, AskPanel chip markup) are deliberate look-before-copy instructions, not gaps.
