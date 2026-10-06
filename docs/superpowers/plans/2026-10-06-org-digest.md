# Organisation Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One page answering "what is going on in our org?" — meetings several people were invited to, then documents and minutes that were deliberately shared — identical for everyone in an institution, assembled from artefacts that were already collective.

**Architecture:** A new `org` NestJS module exposing a single `GET /org/digest?window=` endpoint. Two independent selection queries (meetings; documents + minutes), both scoped to the caller's institution and both returning the same `OrgItem` shape. A short AI narrative sits above them, generated from only those selected items and cached per `(institutionId, window)` in a new table so everyone reads the same sentences. Computed live — no scheduler, no snapshot.

**Tech Stack:** NestJS 11 + Prisma 7 / PostgreSQL (`apps/api`, Jest with hand-rolled Prisma mocks), Next.js 16 (`apps/web`, Vitest + Testing Library).

**Spec:** `docs/superpowers/specs/2026-10-06-org-digest-design.md` (commit `7a13ffe`)

## Global Constraints

- Branch is `ft-hyperscale`. Work directly on it — no worktree.
- PostgreSQL via Prisma, **not SQLite**: raw queries need double-quoted camelCase identifiers and `ILIKE` for case-insensitive matching.
- API tests are Jest with hand-rolled Prisma mocks (`makePrisma()` factories). **There is no test database** — never write a test that needs one.
- Web tests are Vitest + Testing Library, with `vi.mock('@/lib/api', ...)`.
- A global `ValidationPipe({ whitelist: true, transform: true })` is active (`main.ts:56`). Any endpoint taking a typed DTO must decorate every field with class-validator, or `whitelist: true` silently strips it.
- Prisma `undefined` in a `where` clause is a known trap in this repo — it matches everything rather than nothing. Never build a `where` from a possibly-undefined value.
- **The institution is read from the authenticated user, never from a request parameter.** A caller must not be able to ask for another institution's digest.
- **A caller with a NULL institution receives empty lists and no narrative.** The filter fails closed; it never degrades to "show everything".
- `MEETING_MIN_ATTENDEES = 2` (invitees, excluding the organiser, which is a separate column).
- `NARRATIVE_MIN_ITEMS = 5`. Below it, `narrative` is `null` and the lists still render.
- **Meetings lead; documents and minutes follow.** An editorial decision taken against the measurements — do not "fix" the order.
- Ships as one release. No lane goes live alone.
- Run API tests with `cd apps/api && npx jest <path>`; web tests with `cd apps/web && npx vitest run <path>`.

## Review Focus

Five failure modes the spec implies that a happy-path test would miss. Each has a test pinned into the task that owns the code.

1. **A caller with NULL `institutionId` gets a populated digest** instead of an empty one — the fail-open version of the core privacy rule. (Task 2)
2. **Cross-institution leak** — a RISA caller receiving a MINAFFET meeting or document because a query forgot its institution filter. (Tasks 3, 4)
3. **`attendees` is absent, null, or not an array** on some provider's rows, crashing the meetings lane for everyone. (Task 3)
4. **The narrative regenerates when nothing changed**, costing a model call per page view and — worse — giving two colleagues different sentences for the same data. (Task 5)
5. **A model failure takes the whole page down** instead of degrading to lists-only. (Task 5)

---

### Task 1: `OrgDigestNarrative` schema and migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20261006120000_org_digest_narrative/migration.sql`

**Interfaces:**
- Consumes: nothing — first task.
- Produces: the `OrgDigestNarrative` model. Prisma accessor `prisma.orgDigestNarrative`, compound unique key argument `institutionId_window`.

- [ ] **Step 1: Add the model**

Append to `apps/api/prisma/schema.prisma`, after the last model:

```prisma
// One narrative per institution per window — three rows per institution.
// Deliberately NOT AiGeneration: that table is keyed per user, and this text
// must be identical for everyone in the institution.
model OrgDigestNarrative {
  id            String   @id @default(cuid())
  institutionId String
  window        String // 'day' | 'week' | 'month'
  contentHash   String // hash of the item ids the narrative describes
  content       String
  model         String
  generatedAt   DateTime @default(now())

  @@unique([institutionId, window])
  @@index([institutionId])
  @@map("org_digest_narratives")
}
```

- [ ] **Step 2: Validate the schema**

Run: `cd apps/api && npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 3: Hand-author the migration**

The dev DB has drifted, so `migrate dev` would try to reset it. Create the file by hand:

`apps/api/prisma/migrations/20261006120000_org_digest_narrative/migration.sql`:

```sql
-- CreateTable
CREATE TABLE "org_digest_narratives" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_digest_narratives_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "org_digest_narratives_institutionId_idx" ON "org_digest_narratives"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "org_digest_narratives_institutionId_window_key" ON "org_digest_narratives"("institutionId", "window");
```

There is no foreign key to `institutions` on purpose: a narrative row for an institution that is later removed is harmless cached text, and an FK would make institution cleanup fail.

- [ ] **Step 4: Apply and regenerate**

Run: `cd apps/api && npx prisma migrate deploy && npx prisma generate`
Expected: the migration applies, then `Generated Prisma Client`.

- [ ] **Step 5: Confirm the client typing**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(api): add OrgDigestNarrative, one shared narrative per institution and window"
```

---

### Task 2: Foundation — types, institution scoping, endpoint skeleton

**Files:**
- Create: `apps/api/src/org/org.types.ts`
- Create: `apps/api/src/org/org.service.ts`
- Create: `apps/api/src/org/org.controller.ts`
- Create: `apps/api/src/org/org.module.ts`
- Create: `apps/api/src/org/org.service.spec.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: `prisma.orgDigestNarrative` from Task 1.
- Produces, and every later task depends on these exact names:
  - `type DigestWindow = 'day' | 'week' | 'month'`
  - `interface OrgItem { kind: 'meeting' | 'document' | 'minutes'; id: string; title: string; at: string; participantCount: number; href: string }`
  - `interface OrgDigest { window: DigestWindow; institutionId: string | null; narrative: string | null; ahead: OrgItem[]; concluded: OrgItem[] }`
  - `OrgService.resolveInstitution(userId: string): Promise<string | null>`
  - `OrgService.windowRange(window: DigestWindow): { aheadFrom: Date; aheadTo: Date; pastFrom: Date; pastTo: Date }`
  - `OrgService.getDigest(userId: string, window: DigestWindow): Promise<OrgDigest>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/org/org.service.spec.ts`:

```ts
import { OrgService } from './org.service';

export function makePrisma() {
  return {
    user: { findUnique: jest.fn() },
    calendarEvent: { findMany: jest.fn().mockResolvedValue([]) },
    document: { findMany: jest.fn().mockResolvedValue([]) },
    meetingMinutes: { findMany: jest.fn().mockResolvedValue([]) },
    orgDigestNarrative: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
  } as any;
}

const makeService = (prisma: any) => new OrgService(prisma);

describe('OrgService institution scoping', () => {
  it('reads the institution from the user, never from the caller', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ institutionId: 'risa' });
    const svc = makeService(prisma);

    await expect(svc.resolveInstitution('u1')).resolves.toBe('risa');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { institutionId: true },
    });
  });

  // Review Focus #1 — the fail-open version of this is the whole privacy risk.
  it('returns an EMPTY digest when the caller has no institution', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ institutionId: null });
    const svc = makeService(prisma);

    const d = await svc.getDigest('u1', 'week');

    expect(d).toEqual({
      window: 'week', institutionId: null, narrative: null, ahead: [], concluded: [],
    });
    // Nothing may even be queried for a caller with no institution.
    expect(prisma.calendarEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.document.findMany).not.toHaveBeenCalled();
    expect(prisma.meetingMinutes.findMany).not.toHaveBeenCalled();
  });

  it('returns an EMPTY digest when the user row is missing', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const svc = makeService(prisma);

    const d = await svc.getDigest('ghost', 'day');
    expect(d.institutionId).toBeNull();
    expect(d.ahead).toEqual([]);
  });

  it('splits the window into a future and a past range', () => {
    const svc = makeService(makePrisma());
    const r = svc.windowRange('week');
    expect(r.aheadFrom.getTime()).toBeLessThanOrEqual(r.aheadTo.getTime());
    expect(r.pastFrom.getTime()).toBeLessThanOrEqual(r.pastTo.getTime());
    // 7 days each side.
    expect(Math.round((r.aheadTo.getTime() - r.aheadFrom.getTime()) / 86400000)).toBe(7);
    expect(Math.round((r.pastTo.getTime() - r.pastFrom.getTime()) / 86400000)).toBe(7);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx jest src/org/org.service.spec.ts`
Expected: FAIL — cannot resolve `./org.service`.

- [ ] **Step 3: Write the types**

Create `apps/api/src/org/org.types.ts`:

```ts
export type DigestWindow = 'day' | 'week' | 'month';

export const WINDOW_DAYS: Record<DigestWindow, number> = { day: 1, week: 7, month: 30 };

export const DIGEST_WINDOWS: DigestWindow[] = ['day', 'week', 'month'];

/** A meeting is collective at this many invitees. `organizer` is a separate
 *  column, so 2 invitees means three people including the organiser. */
export const MEETING_MIN_ATTENDEES = 2;

/** Below this many items the narrative is suppressed: a model handed three
 *  items pads, and handed zero it invents. */
export const NARRATIVE_MIN_ITEMS = 5;

export interface OrgItem {
  kind: 'meeting' | 'document' | 'minutes';
  /** The artefact's own id, for linking. */
  id: string;
  title: string;
  /** ISO. Start for meetings, last update for documents and minutes. */
  at: string;
  participantCount: number;
  href: string;
}

export interface OrgDigest {
  window: DigestWindow;
  institutionId: string | null;
  narrative: string | null;
  ahead: OrgItem[];
  concluded: OrgItem[];
}
```

- [ ] **Step 4: Write the service skeleton**

Create `apps/api/src/org/org.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  type DigestWindow, type OrgDigest, type OrgItem, WINDOW_DAYS,
} from './org.types';

const DAY_MS = 86_400_000;

@Injectable()
export class OrgService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The caller's institution, read from their own row. Never a parameter:
   * a user must not be able to ask for another institution's digest.
   */
  async resolveInstitution(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { institutionId: true },
    });
    return user?.institutionId ?? null;
  }

  windowRange(window: DigestWindow) {
    const days = WINDOW_DAYS[window];
    const now = new Date();
    return {
      aheadFrom: now,
      aheadTo: new Date(now.getTime() + days * DAY_MS),
      pastFrom: new Date(now.getTime() - days * DAY_MS),
      pastTo: now,
    };
  }

  async getDigest(userId: string, window: DigestWindow): Promise<OrgDigest> {
    const institutionId = await this.resolveInstitution(userId);
    // Fail closed. No institution means no org to report on — never "everything".
    if (!institutionId) {
      return { window, institutionId: null, narrative: null, ahead: [], concluded: [] };
    }

    const ahead: OrgItem[] = [];
    const concluded: OrgItem[] = [];
    return { window, institutionId, narrative: null, ahead, concluded };
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && npx jest src/org/org.service.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Write the controller**

Create `apps/api/src/org/org.controller.ts`:

```ts
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { OrgService } from './org.service';
import { DIGEST_WINDOWS, type DigestWindow, type OrgDigest } from './org.types';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';

@UseGuards(JwtAuthGuard)
@Controller('org')
export class OrgController {
  constructor(private readonly orgService: OrgService) {}

  /**
   * GET /org/digest?window=day|week|month
   * The institution comes from the JWT subject, never from a parameter.
   */
  @Get('digest')
  digest(
    @Req() req: AuthenticatedRequest,
    @Query('window') window?: string,
  ): Promise<OrgDigest> {
    const w: DigestWindow = DIGEST_WINDOWS.includes(window as DigestWindow)
      ? (window as DigestWindow)
      : 'week';
    return this.orgService.getDigest(req.user.sub, w);
  }
}
```

- [ ] **Step 7: Write the module and register it**

Create `apps/api/src/org/org.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { OrgService } from './org.service';
import { OrgController } from './org.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [OrgService],
  controllers: [OrgController],
  exports: [OrgService],
})
export class OrgModule {}
```

In `apps/api/src/app.module.ts`, add the import at the top beside the other module imports:

```ts
import { OrgModule } from './org/org.module';
```

and add `OrgModule,` to the `imports` array, after `AgentModule,`.

- [ ] **Step 8: Verify the app still boots and types check**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json && npx jest`
Expected: no type errors; full suite passes.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/org apps/api/src/app.module.ts
git commit -m "feat(api): org digest skeleton — institution scoping that fails closed"
```

---

### Task 3: Meetings lane

> Independent of Task 4. Both write into the contract Task 2 fixed and touch different queries and different tests.

**Files:**
- Create: `apps/api/src/org/org.meetings.ts`
- Create: `apps/api/src/org/org.meetings.spec.ts`

**Interfaces:**
- Consumes: `OrgItem`, `MEETING_MIN_ATTENDEES` from `./org.types` (Task 2).
- Produces: `selectMeetings(prisma, institutionId, range): Promise<{ ahead: OrgItem[]; concluded: OrgItem[] }>` where `range` is the object returned by `OrgService.windowRange`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/org/org.meetings.spec.ts`:

```ts
import { selectMeetings } from './org.meetings';

const range = {
  aheadFrom: new Date('2026-10-06T00:00:00Z'),
  aheadTo:   new Date('2026-10-13T00:00:00Z'),
  pastFrom:  new Date('2026-09-29T00:00:00Z'),
  pastTo:    new Date('2026-10-06T00:00:00Z'),
};

const ev = (over: Partial<any> = {}) => ({
  id: 'e1',
  title: 'Network readiness review',
  startAt: new Date('2026-10-08T09:00:00Z'),
  icalUid: 'uid-1',
  attendees: [{ email: 'a@risa.gov.rw' }, { email: 'b@risa.gov.rw' }],
  ...over,
});

function makePrisma(rows: any[]) {
  return { calendarEvent: { findMany: jest.fn().mockResolvedValue(rows) } } as any;
}

describe('selectMeetings', () => {
  // Review Focus #2 — a missing institution filter is a cross-institution leak.
  it('scopes every query to the institution', async () => {
    const prisma = makePrisma([]);
    await selectMeetings(prisma, 'risa', range);
    for (const call of prisma.calendarEvent.findMany.mock.calls) {
      expect(call[0].where.user).toEqual({ institutionId: 'risa' });
    }
  });

  it('keeps an event at the attendee threshold', async () => {
    const prisma = makePrisma([ev()]);
    const out = await selectMeetings(prisma, 'risa', range);
    expect(out.ahead).toHaveLength(1);
    expect(out.ahead[0]).toEqual({
      kind: 'meeting',
      id: 'e1',
      title: 'Network readiness review',
      at: '2026-10-08T09:00:00.000Z',
      participantCount: 2,
      href: '/calendar?event=e1',
    });
  });

  it('drops an event below the threshold', async () => {
    const prisma = makePrisma([ev({ attendees: [{ email: 'only@risa.gov.rw' }] })]);
    const out = await selectMeetings(prisma, 'risa', range);
    expect(out.ahead).toHaveLength(0);
  });

  // Review Focus #3 — providers vary; a bad column must not break the lane.
  it('survives attendees that are null, missing, or not an array', async () => {
    const prisma = makePrisma([
      ev({ id: 'a', attendees: null }),
      ev({ id: 'b', attendees: undefined }),
      ev({ id: 'c', attendees: 'nonsense' }),
      ev({ id: 'd', attendees: {} }),
    ]);
    const out = await selectMeetings(prisma, 'risa', range);
    expect(out.ahead).toEqual([]);
    expect(out.concluded).toEqual([]);
  });

  it('shows a meeting once when two mailboxes hold it', async () => {
    const prisma = makePrisma([
      ev({ id: 'copy-1', icalUid: 'shared-uid' }),
      ev({ id: 'copy-2', icalUid: 'shared-uid' }),
    ]);
    const out = await selectMeetings(prisma, 'risa', range);
    expect(out.ahead).toHaveLength(1);
  });

  // icalUid is absent on most historical rows; the fallback key carries them.
  it('de-duplicates on title and start when icalUid is missing', async () => {
    const prisma = makePrisma([
      ev({ id: 'x', icalUid: null }),
      ev({ id: 'y', icalUid: null, title: 'NETWORK READINESS REVIEW' }),
    ]);
    const out = await selectMeetings(prisma, 'risa', range);
    expect(out.ahead).toHaveLength(1);
  });

  it('separates future meetings from concluded ones', async () => {
    const prisma = makePrisma([]);
    await selectMeetings(prisma, 'risa', range);
    const wheres = prisma.calendarEvent.findMany.mock.calls.map((c: any[]) => c[0].where.startAt);
    expect(wheres).toContainEqual({ gte: range.aheadFrom, lte: range.aheadTo });
    expect(wheres).toContainEqual({ gte: range.pastFrom, lt: range.pastTo });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx jest src/org/org.meetings.spec.ts`
Expected: FAIL — cannot resolve `./org.meetings`.

- [ ] **Step 3: Implement**

Create `apps/api/src/org/org.meetings.ts`:

```ts
import { MEETING_MIN_ATTENDEES, type OrgItem } from './org.types';

interface Range {
  aheadFrom: Date; aheadTo: Date; pastFrom: Date; pastTo: Date;
}

const EVENT_SELECT = {
  id: true, title: true, startAt: true, icalUid: true, attendees: true,
} as const;

/** The provider fills `attendees` on the organiser's row; other shapes have
 *  been seen in the wild, so anything that is not an array counts as zero. */
function attendeeCount(attendees: unknown): number {
  return Array.isArray(attendees) ? attendees.length : 0;
}

/**
 * Identity for de-duplication. `icalUid` is the real key, but it is absent on
 * most rows synced before it was introduced, so fall back to the pair that
 * actually identifies a meeting to a reader.
 */
function dedupeKey(row: { icalUid: string | null; title: string; startAt: Date }): string {
  return row.icalUid ?? `${row.title.trim().toLowerCase()}|${row.startAt.toISOString()}`;
}

function toItems(rows: Array<{
  id: string; title: string; startAt: Date; icalUid: string | null; attendees: unknown;
}>): OrgItem[] {
  const seen = new Set<string>();
  const out: OrgItem[] = [];
  for (const r of rows) {
    const count = attendeeCount(r.attendees);
    if (count < MEETING_MIN_ATTENDEES) continue;
    const key = dedupeKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: 'meeting',
      id: r.id,
      title: r.title,
      at: r.startAt.toISOString(),
      participantCount: count,
      href: `/calendar?event=${r.id}`,
    });
  }
  return out;
}

/**
 * Meetings the institution is collectively having. Selection counts the
 * INVITATION, not how many mailboxes have synced a copy: only a fraction of
 * mailboxes carry an icalUid at all, so counting rows would measure sync
 * coverage rather than what the institution is doing.
 */
export async function selectMeetings(
  prisma: any,
  institutionId: string,
  range: Range,
): Promise<{ ahead: OrgItem[]; concluded: OrgItem[] }> {
  const [aheadRows, pastRows] = await Promise.all([
    prisma.calendarEvent.findMany({
      where: { user: { institutionId }, startAt: { gte: range.aheadFrom, lte: range.aheadTo } },
      select: EVENT_SELECT,
      orderBy: { startAt: 'asc' },
    }),
    prisma.calendarEvent.findMany({
      where: { user: { institutionId }, startAt: { gte: range.pastFrom, lt: range.pastTo } },
      select: EVENT_SELECT,
      orderBy: { startAt: 'desc' },
    }),
  ]);
  return { ahead: toItems(aheadRows), concluded: toItems(pastRows) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx jest src/org/org.meetings.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/org/org.meetings.ts apps/api/src/org/org.meetings.spec.ts
git commit -m "feat(api): org digest meetings lane, counting the invitation not the mailboxes"
```

---

### Task 4: Documents and minutes lane

> Independent of Task 3.

**Files:**
- Create: `apps/api/src/org/org.documents.ts`
- Create: `apps/api/src/org/org.documents.spec.ts`

**Interfaces:**
- Consumes: `OrgItem` from `./org.types` (Task 2).
- Produces: `selectDocumentsAndMinutes(prisma, institutionId, range): Promise<{ concluded: OrgItem[] }>`. Documents and minutes are retrospective only — they contribute nothing to `ahead`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/org/org.documents.spec.ts`:

```ts
import { selectDocumentsAndMinutes } from './org.documents';

const range = {
  aheadFrom: new Date('2026-10-06T00:00:00Z'),
  aheadTo:   new Date('2026-10-13T00:00:00Z'),
  pastFrom:  new Date('2026-09-29T00:00:00Z'),
  pastTo:    new Date('2026-10-06T00:00:00Z'),
};

function makePrisma(docs: any[] = [], minutes: any[] = []) {
  return {
    document: { findMany: jest.fn().mockResolvedValue(docs) },
    meetingMinutes: { findMany: jest.fn().mockResolvedValue(minutes) },
  } as any;
}

const doc = (over: Partial<any> = {}) => ({
  id: 'd1',
  title: 'Q4 procurement plan',
  updatedAt: new Date('2026-10-02T10:00:00Z'),
  isShared: true,
  invites: [],
  ...over,
});

describe('selectDocumentsAndMinutes', () => {
  // Review Focus #2 — the leak that matters.
  it('scopes documents and minutes to the institution', async () => {
    const prisma = makePrisma();
    await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(prisma.document.findMany.mock.calls[0][0].where.user)
      .toEqual({ institutionId: 'risa' });
    expect(prisma.meetingMinutes.findMany.mock.calls[0][0].where.document)
      .toEqual({ user: { institutionId: 'risa' } });
  });

  it('includes a link-shared document', async () => {
    const prisma = makePrisma([doc()]);
    const out = await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(out.concluded).toContainEqual({
      kind: 'document',
      id: 'd1',
      title: 'Q4 procurement plan',
      at: '2026-10-02T10:00:00.000Z',
      participantCount: 0,
      href: '/docs?open=d1',
    });
  });

  it('counts invitees as participants', async () => {
    const prisma = makePrisma([doc({ isShared: false, invites: [{ id: 'i1' }, { id: 'i2' }] })]);
    const out = await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(out.concluded[0].participantCount).toBe(2);
  });

  it('asks only for documents that are shared or invited', async () => {
    const prisma = makePrisma();
    await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(prisma.document.findMany.mock.calls[0][0].where.OR).toEqual([
      { isShared: true },
      { invites: { some: {} } },
    ]);
  });

  it('includes minutes, titled from their document', async () => {
    const prisma = makePrisma([], [{
      id: 'm1',
      createdAt: new Date('2026-10-03T08:00:00Z'),
      documentId: 'doc-9',
      document: { title: 'Minutes — 2G/3G sunset' },
    }]);
    const out = await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(out.concluded).toContainEqual({
      kind: 'minutes',
      id: 'm1',
      title: 'Minutes — 2G/3G sunset',
      at: '2026-10-03T08:00:00.000Z',
      participantCount: 0,
      href: '/docs?open=doc-9',
    });
  });

  it('returns newest first across both kinds', async () => {
    const prisma = makePrisma(
      [doc({ id: 'older', updatedAt: new Date('2026-10-01T00:00:00Z') })],
      [{ id: 'newer', createdAt: new Date('2026-10-04T00:00:00Z'), documentId: 'x', document: { title: 'M' } }],
    );
    const out = await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(out.concluded.map((i) => i.id)).toEqual(['newer', 'older']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx jest src/org/org.documents.spec.ts`
Expected: FAIL — cannot resolve `./org.documents`.

- [ ] **Step 3: Implement**

Create `apps/api/src/org/org.documents.ts`:

```ts
import { type OrgItem } from './org.types';

interface Range {
  aheadFrom: Date; aheadTo: Date; pastFrom: Date; pastTo: Date;
}

/**
 * Documents and minutes the institution deliberately made collective.
 * Retrospective only — a document has no future date, so this contributes
 * nothing to the `ahead` lane.
 *
 * A document qualifies on `isShared` (a share link exists) or on having at
 * least one invite. Both are explicit acts by the owner, which is what makes
 * surfacing them disclose nothing new.
 */
export async function selectDocumentsAndMinutes(
  prisma: any,
  institutionId: string,
  range: Range,
): Promise<{ concluded: OrgItem[] }> {
  const [docs, minutes] = await Promise.all([
    prisma.document.findMany({
      where: {
        user: { institutionId },
        updatedAt: { gte: range.pastFrom, lte: range.pastTo },
        OR: [{ isShared: true }, { invites: { some: {} } }],
      },
      select: { id: true, title: true, updatedAt: true, invites: { select: { id: true } } },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.meetingMinutes.findMany({
      where: {
        document: { user: { institutionId } },
        createdAt: { gte: range.pastFrom, lte: range.pastTo },
      },
      select: {
        id: true, createdAt: true, documentId: true,
        document: { select: { title: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const items: OrgItem[] = [
    ...docs.map((d: any) => ({
      kind: 'document' as const,
      id: d.id,
      title: d.title,
      at: d.updatedAt.toISOString(),
      participantCount: d.invites?.length ?? 0,
      href: `/docs?open=${d.id}`,
    })),
    ...minutes.map((m: any) => ({
      kind: 'minutes' as const,
      id: m.id,
      title: m.document?.title ?? 'Meeting minutes',
      at: m.createdAt.toISOString(),
      participantCount: 0,
      href: `/docs?open=${m.documentId}`,
    })),
  ];

  items.sort((a, b) => b.at.localeCompare(a.at));
  return { concluded: items };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx jest src/org/org.documents.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/org/org.documents.ts apps/api/src/org/org.documents.spec.ts
git commit -m "feat(api): org digest documents and minutes lane"
```

---

### Task 5: Narrative, and assembling the digest

**Files:**
- Create: `apps/api/src/org/org.narrative.ts`
- Create: `apps/api/src/org/org.narrative.spec.ts`
- Modify: `apps/api/src/org/org.service.ts`
- Modify: `apps/api/src/org/org.service.spec.ts`
- Modify: `apps/api/src/org/org.module.ts`

**Interfaces:**
- Consumes: `selectMeetings` (Task 3), `selectDocumentsAndMinutes` (Task 4), `NARRATIVE_MIN_ITEMS` and `OrgItem` (Task 2), `AiService.upstream(body, signal)` and `consumeAgentJson(upstream, onDelta)`.
- Produces: `contentHashOf(items: OrgItem[]): string` and `OrgNarrativeService.get(institutionId, window, items): Promise<string | null>`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/org/org.narrative.spec.ts`:

```ts
import { contentHashOf, OrgNarrativeService } from './org.narrative';
import type { OrgItem } from './org.types';

const item = (id: string): OrgItem => ({
  kind: 'meeting', id, title: `Meeting ${id}`,
  at: '2026-10-08T09:00:00.000Z', participantCount: 3, href: `/calendar?event=${id}`,
});
const five = ['a', 'b', 'c', 'd', 'e'].map(item);

function makePrisma(existing: any = null) {
  return {
    orgDigestNarrative: {
      findUnique: jest.fn().mockResolvedValue(existing),
      upsert: jest.fn().mockResolvedValue({}),
    },
  } as any;
}
const makeAi = (text = 'The institution is focused on network readiness.') => ({
  upstream: jest.fn().mockResolvedValue({
    json: async () => ({ choices: [{ message: { content: text } }] }),
  }),
}) as any;

describe('contentHashOf', () => {
  it('is stable regardless of item order', () => {
    expect(contentHashOf([item('a'), item('b')])).toBe(contentHashOf([item('b'), item('a')]));
  });
  it('changes when the items change', () => {
    expect(contentHashOf([item('a')])).not.toBe(contentHashOf([item('a'), item('b')]));
  });
});

describe('OrgNarrativeService', () => {
  // Review Focus #4 — regenerating per view costs a call each time AND gives
  // two colleagues different sentences for identical data.
  it('reuses the cached narrative when the items have not changed', async () => {
    const prisma = makePrisma({
      contentHash: contentHashOf(five), content: 'cached text', generatedAt: new Date(),
    });
    const ai = makeAi();
    const svc = new OrgNarrativeService(prisma, ai);

    await expect(svc.get('risa', 'week', five)).resolves.toBe('cached text');
    expect(ai.upstream).not.toHaveBeenCalled();
  });

  it('regenerates when the items changed', async () => {
    const prisma = makePrisma({ contentHash: 'stale', content: 'old', generatedAt: new Date() });
    const ai = makeAi('fresh text');
    const svc = new OrgNarrativeService(prisma, ai);

    await expect(svc.get('risa', 'week', five)).resolves.toBe('fresh text');
    expect(ai.upstream).toHaveBeenCalled();
    expect(prisma.orgDigestNarrative.upsert).toHaveBeenCalled();
  });

  it('suppresses the narrative below the floor', async () => {
    const prisma = makePrisma();
    const ai = makeAi();
    const svc = new OrgNarrativeService(prisma, ai);

    await expect(svc.get('risa', 'week', [item('a'), item('b')])).resolves.toBeNull();
    expect(ai.upstream).not.toHaveBeenCalled();
  });

  // Review Focus #5 — the page must survive the model being down.
  it('returns null rather than throwing when generation fails', async () => {
    const prisma = makePrisma();
    const ai = { upstream: jest.fn().mockRejectedValue(new Error('model down')) } as any;
    const svc = new OrgNarrativeService(prisma, ai);

    await expect(svc.get('risa', 'week', five)).resolves.toBeNull();
  });

  it('sends the model only titles, dates and counts — never a body', async () => {
    const prisma = makePrisma();
    const ai = makeAi();
    const svc = new OrgNarrativeService(prisma, ai);
    await svc.get('risa', 'week', five);

    const body = ai.upstream.mock.calls[0][0];
    const sent = JSON.stringify(body);
    expect(sent).toContain('Meeting a');
    expect(sent).not.toContain('href');
    expect(sent).not.toContain('/calendar?event=');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx jest src/org/org.narrative.spec.ts`
Expected: FAIL — cannot resolve `./org.narrative`.

- [ ] **Step 3: Implement the narrative service**

Create `apps/api/src/org/org.narrative.ts`:

```ts
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { consumeAgentJson } from '../agent/upstream-stream';
import { NARRATIVE_MIN_ITEMS, type DigestWindow, type OrgItem } from './org.types';

const MODEL_TIMEOUT_MS = 20_000;

/** Stable across ordering so a reshuffle does not force a regeneration. */
export function contentHashOf(items: OrgItem[]): string {
  const ids = items.map((i) => `${i.kind}:${i.id}`).sort().join(',');
  return createHash('sha256').update(ids).digest('hex');
}

@Injectable()
export class OrgNarrativeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
  ) {}

  /**
   * Two or three sentences over the items already selected for the lists.
   *
   * Cached per (institution, window) so everyone in the institution reads the
   * same sentences for one generation per period, rather than one per login.
   * Returns null — never throws — when below the floor or when the model is
   * unavailable: the digest must not fail because generation did.
   */
  async get(
    institutionId: string,
    window: DigestWindow,
    items: OrgItem[],
  ): Promise<string | null> {
    if (items.length < NARRATIVE_MIN_ITEMS) return null;

    const hash = contentHashOf(items);
    const cached = await this.prisma.orgDigestNarrative.findUnique({
      where: { institutionId_window: { institutionId, window } },
    });
    if (cached && cached.contentHash === hash) return cached.content;

    let text: string;
    try {
      text = await this.generate(items, window);
    } catch {
      return null;
    }
    if (!text.trim()) return null;

    await this.prisma.orgDigestNarrative.upsert({
      where: { institutionId_window: { institutionId, window } },
      create: { institutionId, window, contentHash: hash, content: text, model: 'default' },
      update: { contentHash: hash, content: text, model: 'default', generatedAt: new Date() },
    });
    return text;
  }

  /**
   * The model sees ONLY what is already on the page: kind, title, date and
   * participant count. No message, no document body, no link — every claim it
   * can make is traceable to a row rendered directly beneath it.
   */
  private async generate(items: OrgItem[], window: DigestWindow): Promise<string> {
    const lines = items
      .map((i) => `- [${i.kind}] ${i.title} (${i.at.slice(0, 10)}, ${i.participantCount} people)`)
      .join('\n');
    const body = {
      messages: [
        {
          role: 'system',
          content:
            'You summarise an organisation\'s activity for colleagues. Write two or three ' +
            'plain sentences about what the organisation is collectively working on. Use ONLY ' +
            'the items given. Never invent a project, person, or deadline. No bullet points, ' +
            'no preamble, no heading.',
        },
        { role: 'user', content: `Activity for this ${window}:\n${lines}` },
      ],
      max_tokens: 220,
      temperature: 0.2,
    } as any;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), MODEL_TIMEOUT_MS);
    try {
      const upstream = await this.ai.upstream(body, ac.signal);
      const result = await consumeAgentJson(upstream, () => {});
      return result.text.trim();
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Run the narrative test to verify it passes**

Run: `cd apps/api && npx jest src/org/org.narrative.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Assemble the digest in the service**

In `apps/api/src/org/org.service.ts`, add the imports:

```ts
import { selectMeetings } from './org.meetings';
import { selectDocumentsAndMinutes } from './org.documents';
import { OrgNarrativeService } from './org.narrative';
```

Change the constructor:

```ts
  constructor(
    private readonly prisma: PrismaService,
    private readonly narrative: OrgNarrativeService,
  ) {}
```

and replace the body of `getDigest` after the fail-closed guard:

```ts
    const range = this.windowRange(window);
    const [meetings, docs] = await Promise.all([
      selectMeetings(this.prisma, institutionId, range),
      selectDocumentsAndMinutes(this.prisma, institutionId, range),
    ]);

    // Meetings lead. Deliberate editorial ordering — do not sort these together.
    const ahead = meetings.ahead;
    const concluded = [...meetings.concluded, ...docs.concluded];

    const narrative = await this.narrative.get(institutionId, window, [...ahead, ...concluded]);
    return { window, institutionId, narrative, ahead, concluded };
  }
```

- [ ] **Step 6: Register the narrative service**

In `apps/api/src/org/org.module.ts`, import `AiModule` and add `OrgNarrativeService`:

```ts
import { Module } from '@nestjs/common';
import { OrgService } from './org.service';
import { OrgNarrativeService } from './org.narrative';
import { OrgController } from './org.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [PrismaModule, AiModule],
  providers: [OrgService, OrgNarrativeService],
  controllers: [OrgController],
  exports: [OrgService],
})
export class OrgModule {}
```

- [ ] **Step 7: Update the service spec for the new constructor**

In `apps/api/src/org/org.service.spec.ts`, replace `makeService`:

```ts
const makeNarrative = () => ({ get: jest.fn().mockResolvedValue(null) }) as any;
const makeService = (prisma: any, narrative: any = makeNarrative()) =>
  new OrgService(prisma, narrative);
```

and add a test that the ordering contract holds:

```ts
it('puts meetings ahead of documents in the concluded list', async () => {
  const prisma = makePrisma();
  prisma.user.findUnique.mockResolvedValue({ institutionId: 'risa' });
  prisma.calendarEvent.findMany.mockResolvedValue([{
    id: 'past-meeting', title: 'Review', startAt: new Date('2026-10-01T09:00:00Z'),
    icalUid: 'u', attendees: [{ email: 'a@x' }, { email: 'b@x' }],
  }]);
  prisma.document.findMany.mockResolvedValue([{
    id: 'doc', title: 'Plan', updatedAt: new Date('2026-10-05T09:00:00Z'), invites: [],
  }]);
  const svc = makeService(prisma);

  const d = await svc.getDigest('u1', 'week');
  // The document is NEWER, and still comes second: meetings lead by decision.
  expect(d.concluded.map((i: any) => i.kind)).toEqual(['meeting', 'document']);
});
```

- [ ] **Step 8: Run the whole API suite**

Run: `cd apps/api && npx jest && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/org
git commit -m "feat(api): grounded org narrative, cached per institution and window"
```

---

### Task 6: The page

**Files:**
- Modify: `apps/web/lib/api.ts`
- Create: `apps/web/app/(app)/org/page.tsx`
- Create: `apps/web/components/org/OrgDigest.tsx`
- Create: `apps/web/components/org/OrgDigest.test.tsx`
- Modify: `apps/web/components/layout/Sidebar.tsx:812` (nav entries)

**Interfaces:**
- Consumes: `GET /org/digest?window=` returning the `OrgDigest` shape from Task 2.
- Produces: `api.org.digest(window)` and the `<OrgDigest />` component.

- [ ] **Step 1: Write the failing test**

Create `apps/web/components/org/OrgDigest.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { OrgDigest } from './OrgDigest';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: { org: { digest: vi.fn() } },
}));
const digest = api.org.digest as unknown as ReturnType<typeof vi.fn>;

const payload = (over: Partial<any> = {}) => ({
  window: 'week',
  institutionId: 'risa',
  narrative: 'The institution is focused on network readiness.',
  ahead: [{
    kind: 'meeting', id: 'e1', title: 'Network readiness review',
    at: '2026-10-08T09:00:00.000Z', participantCount: 12, href: '/calendar?event=e1',
  }],
  concluded: [{
    kind: 'document', id: 'd1', title: 'Q4 procurement plan',
    at: '2026-10-02T10:00:00.000Z', participantCount: 3, href: '/docs?open=d1',
  }],
  ...over,
});

describe('OrgDigest', () => {
  beforeEach(() => { digest.mockReset(); digest.mockResolvedValue(payload()); });
  afterEach(() => cleanup());

  it('shows the narrative and both lanes', async () => {
    render(<OrgDigest />);
    expect(await screen.findByText(/focused on network readiness/i)).toBeInTheDocument();
    expect(screen.getByText('Network readiness review')).toBeInTheDocument();
    expect(screen.getByText('Q4 procurement plan')).toBeInTheDocument();
  });

  it('defaults to the week window and can switch', async () => {
    render(<OrgDigest />);
    await waitFor(() => expect(digest).toHaveBeenCalledWith('week'));
    fireEvent.click(screen.getByRole('button', { name: /today/i }));
    await waitFor(() => expect(digest).toHaveBeenCalledWith('day'));
  });

  it('renders the lists when there is no narrative', async () => {
    digest.mockResolvedValue(payload({ narrative: null }));
    render(<OrgDigest />);
    expect(await screen.findByText('Network readiness review')).toBeInTheDocument();
  });

  it('says so, kindly, when the institution has nothing to show', async () => {
    digest.mockResolvedValue(payload({ narrative: null, ahead: [], concluded: [] }));
    render(<OrgDigest />);
    expect(await screen.findByText(/nothing shared yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run components/org/OrgDigest.test.tsx`
Expected: FAIL — cannot resolve `./OrgDigest`.

- [ ] **Step 3: Add the API client method**

In `apps/web/lib/api.ts`, add a new namespace beside the others (e.g. after `contacts`):

```ts
  org: {
    /** The institution-level digest. The server derives the institution from
     *  the caller; there is deliberately no parameter for it. */
    digest: (window: 'day' | 'week' | 'month' = 'week') => {
      if (USE_MOCK) {
        return delay<any>({ window, institutionId: null, narrative: null, ahead: [], concluded: [] });
      }
      return request<any>(`/org/digest?window=${window}`);
    },
  },
```

- [ ] **Step 4: Write the component**

Create `apps/web/components/org/OrgDigest.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

type Window = 'day' | 'week' | 'month';
const WINDOWS: Array<[Window, string]> = [
  ['day', 'Today'], ['week', 'This week'], ['month', 'This month'],
];

interface Item {
  kind: 'meeting' | 'document' | 'minutes';
  id: string; title: string; at: string; participantCount: number; href: string;
}

function Lane({ heading, items }: { heading: string; items: Item[] }) {
  if (items.length === 0) return null;
  return (
    <section className="mb-8">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/60 mb-3">
        {heading}
      </h2>
      <ul className="flex flex-col gap-1.5">
        {items.map((i) => (
          <li key={`${i.kind}:${i.id}`}>
            <Link href={i.href} className="flex items-baseline justify-between gap-4 py-1.5 hover:text-primary">
              <span className="text-sm truncate">{i.title}</span>
              <span className="text-xs text-muted-foreground/60 shrink-0">
                {new Date(i.at).toLocaleDateString()}
                {i.participantCount > 0 && ` · ${i.participantCount} people`}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function OrgDigest() {
  const [window, setWindow] = useState<Window>('week');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (w: Window) => {
    setLoading(true);
    try { setData(await api.org.digest(w)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(window); }, [window, load]);

  const empty = data && data.ahead.length === 0 && data.concluded.length === 0;

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="flex items-center gap-1 mb-6">
        {WINDOWS.map(([w, label]) => (
          <button
            key={w}
            onClick={() => setWindow(w)}
            className={`px-3 py-1 text-xs rounded-full transition-colors ${
              w === window ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
        {loading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground/50 ml-2" />}
      </div>

      {data?.narrative && (
        <p className="text-base leading-relaxed mb-8">{data.narrative}</p>
      )}

      {empty ? (
        <p className="text-sm text-muted-foreground/60">
          Nothing shared yet for this period. Meetings with several people, and documents
          shared with colleagues, will appear here.
        </p>
      ) : (
        <>
          {/* Meetings lead — a deliberate editorial choice, not an accident. */}
          <Lane heading="Ahead" items={data?.ahead ?? []} />
          <Lane heading="Concluded" items={data?.concluded ?? []} />
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Add the page and the nav entry**

Create `apps/web/app/(app)/org/page.tsx`:

```tsx
import { OrgDigest } from '@/components/org/OrgDigest';

export default function OrgPage() {
  return <OrgDigest />;
}
```

The rail is `apps/web/components/layout/Sidebar.tsx`. Its entries are one-liners
sharing a `NavItem` component; the Docs entry at line 812 is the shape to copy:

```tsx
<NavItem icon={BookOpen} label="Docs" onClick={() => { router.push('/docs'); onClose?.(); }} tourId="docs-nav" collapsed={railMode} />
```

Add `Building2` to the `lucide-react` import block (it sits with `Calendar, Users,
FolderOpen,` around line 12), then add this line directly after the Docs entry:

```tsx
<NavItem icon={Building2} label="Organisation" onClick={() => { router.push('/org'); onClose?.(); }} tourId="org-nav" collapsed={railMode} />
```

Place it after Docs and before the "Chat history" entry — grouped with the other
browse destinations rather than in the "Upcoming features" block further down.

- [ ] **Step 6: Run the tests**

Run: `cd apps/web && npx vitest run components/org/OrgDigest.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 7: Full verification**

Run: `cd apps/web && npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass; the build succeeds.

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/api.ts apps/web/components/org apps/web/app/\(app\)/org
git commit -m "feat(web): organisation digest page"
```

---

## Done

After Task 6 the flow works end to end: open Organisation, pick a window, read two or three sentences over the institution's meetings and shared documents.

**Before deploying:**

```bash
cd apps/api && npx jest && cd ../web && npx vitest run && npx tsc --noEmit && npm run build
```

**Deploy notes.** This has a migration, so the api bundle ships and `prisma migrate deploy` runs on both VMs. Per the standing rule the live smoke uses internal test addresses only — though this feature sends nothing, so the smoke is read-only.

**The one thing to check live that no unit test can prove:** sign in as a RISA account and a MINAFFET account and confirm the digests differ. Institution isolation is the whole privacy position, and mocked Prisma cannot demonstrate it against real rows.

**Expect the Ahead lane to look sparse.** At the last measurement only 11 of 148 recent events had more than one attendee. That is the data, not a bug, and it is why the narrative floor exists.
