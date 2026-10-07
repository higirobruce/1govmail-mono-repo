# Shareable Email Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user share a contact group with named colleagues and drop that whole group into a message as editable recipient chips, instead of picking recipients one by one or asking the admin for a distribution list.

**Architecture:** A new `GroupInvite` table carries sharing, read back through the same `OR: [{ userId }, { invites: { some: { invitedEmail } } }]` ACL query that already guards shared documents. Groups are then merged into the existing recipient-autocomplete endpoint behind an opt-in `groups=true` flag, and selecting a group suggestion in the compose chip input expands it into ordinary, removable recipient chips. Nothing about a chip remembers the group, which is what lets a user drop one person for one message.

**Tech Stack:** NestJS 11 + Prisma 7 / PostgreSQL (`apps/api`, Jest), Next.js 16 + React (`apps/web`, Vitest + Testing Library).

**Spec:** `docs/superpowers/specs/2026-09-28-email-groups-design.md` (commit `f1a6b2b`)

## Global Constraints

- Branch is `ft-hyperscale`. Do not create a worktree — this repo's plans run directly on the branch.
- PostgreSQL via Prisma, **not SQLite**: raw queries need double-quoted camelCase identifiers and `ILIKE` for case-insensitive matching.
- API tests are Jest with hand-rolled Prisma mocks (`makePrisma()` factories). There is **no test database** — never write a test that needs one.
- Web tests are Vitest + Testing Library, with `vi.mock('@/lib/api', ...)`.
- A global `ValidationPipe({ whitelist: true, transform: true })` is active (`main.ts:56`). Any endpoint taking a typed DTO must decorate every field with class-validator, or `whitelist: true` silently strips it.
- Prisma `undefined` in a `where` clause is a known trap in this repo — it matches everything rather than nothing. Never build a `where` from a possibly-undefined value.
- Email comparison is normalised **trim + lowercase** on both write and read, everywhere in this feature.
- Group member cap in compose: **50** chips, remainder collapses to one `+N more` chip.
- `GroupInvite.role` defaults to **`VIEWER`** — deliberately unlike `DocumentInvite`, which defaults to `EDITOR`.
- Run API tests with `cd apps/api && npx jest <path>`; web tests with `cd apps/web && npx vitest run <path>`.

## Review Focus

Five failure modes the spec implies but that no task's happy path exercises. Each has a test pinned into the task that owns the code.

1. **Case- or whitespace-variant invite email never matches at read time** — invited as `Alice@risa.gov.rw`, signs in as `alice@risa.gov.rw`, and the shared group is invisible forever. Normalise on write *and* read. (Task 4, Task 2)
2. **Re-inviting the same person raises the unique constraint as a 500** instead of being idempotent. (Task 4)
3. **The hook's `exclude` filter meets a group suggestion that has no `email` field** — `exclude.includes(undefined)` must not crash or silently drop the group. (Task 6)
4. **The autocomplete arity change breaks Advanced Search** — the existing test asserts `toHaveBeenCalledWith('al')`, so the no-groups path must still call the client with exactly one argument. (Task 6)
5. **A group with zero, blank, or duplicate member emails** yields blank chips or silently does nothing. (Task 7)

---

### Task 1: `GroupInvite` schema and migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (the `User` relation block ~line 43-46, `ContactGroup` ~line 577)
- Create: `apps/api/prisma/migrations/<timestamp>_group_invites/migration.sql`

**Interfaces:**
- Consumes: nothing — this is the first task.
- Produces: the `GroupInvite` model with fields `id`, `groupId`, `invitedEmail`, `invitedBy`, `role: InviteRole`, `createdAt`; relation `ContactGroup.invites: GroupInvite[]`; relation `User.sentGroupInvites: GroupInvite[]`. Prisma client accessor is `prisma.groupInvite`.

- [ ] **Step 1: Add the model to the schema**

Add to `apps/api/prisma/schema.prisma`, directly below the existing `ContactGroup` model:

```prisma
model GroupInvite {
  id           String     @id @default(cuid())
  groupId      String
  invitedEmail String
  invitedBy    String
  role         InviteRole @default(VIEWER)
  createdAt    DateTime   @default(now())

  group   ContactGroup @relation(fields: [groupId], references: [id], onDelete: Cascade)
  inviter User         @relation(fields: [invitedBy], references: [id], onDelete: Cascade)

  @@unique([groupId, invitedEmail])
  @@index([invitedEmail])
  @@map("group_invites")
}
```

- [ ] **Step 2: Add both back-relations**

In `model ContactGroup`, add below the existing `user` relation line:

```prisma
  invites GroupInvite[]
```

In `model User`, add immediately after the existing `contactGroups        ContactGroup[]` line (~line 43):

```prisma
  sentGroupInvites     GroupInvite[]
```

- [ ] **Step 3: Verify the schema is valid**

Run: `cd apps/api && npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

If it reports a missing opposite relation field, one of the two back-relations in Step 2 is missing.

- [ ] **Step 4: Hand-author the migration**

The dev DB has drifted, so `migrate dev` would try to reset it. Create the directory and file by hand, following the workflow already used for the agent-tool and minutes work. Use a timestamp matching the existing naming convention (`ls apps/api/prisma/migrations` to see the format).

`apps/api/prisma/migrations/20260928000000_group_invites/migration.sql`:

```sql
-- CreateTable
CREATE TABLE "group_invites" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "invitedEmail" TEXT NOT NULL,
    "invitedBy" TEXT NOT NULL,
    "role" "InviteRole" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_invites_invitedEmail_idx" ON "group_invites"("invitedEmail");

-- CreateIndex
CREATE UNIQUE INDEX "group_invites_groupId_invitedEmail_key" ON "group_invites"("groupId", "invitedEmail");

-- AddForeignKey
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "contact_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_invitedBy_fkey"
  FOREIGN KEY ("invitedBy") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

The `"InviteRole"` enum type already exists in the database from the document-sharing migration — do **not** create it again.

- [ ] **Step 5: Apply the migration and regenerate the client**

Run: `cd apps/api && npx prisma migrate deploy && npx prisma generate`
Expected: the migration applies, then `Generated Prisma Client`.

- [ ] **Step 6: Verify the table and the client accessor exist**

Run: `cd apps/api && npx prisma db execute --stdin <<< 'SELECT column_name FROM information_schema.columns WHERE table_name = '"'"'group_invites'"'"' ORDER BY column_name;'`
Expected: the command succeeds (Prisma prints no rows for `db execute`, but a missing table errors).

Then confirm the client typing:

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(api): add GroupInvite for shareable contact groups"
```

---

### Task 2: `getUserEmail` and the ACL read query

**Files:**
- Modify: `apps/api/src/contacts/contacts.service.ts` (add `getUserEmail`; replace `getGroups` ~line 351)
- Create: `apps/api/src/contacts/contacts.groups.spec.ts`

**Interfaces:**
- Consumes: `prisma.groupInvite` and `ContactGroup.invites` from Task 1.
- Produces:
  - `private async getUserEmail(userId: string): Promise<string>` — returns the trimmed, lowercased email; throws `NotFoundException('User not found')` when there is no row. **Does not check `authToken`.**
  - `getGroups(userId: string)` now returns groups owned by the user *or* shared with them, each with an `invites` array.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/contacts/contacts.groups.spec.ts`:

```ts
import { NotFoundException } from '@nestjs/common';
import { ContactsService } from './contacts.service';

function makePrisma() {
  return {
    user: { findUnique: jest.fn() },
    contactGroup: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    groupInvite: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
  } as any;
}

const makeService = (prisma: any) => new ContactsService(prisma, {} as any);

describe('ContactsService.getGroups — access', () => {
  it('returns groups I own and groups shared with me', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'me@risa.gov.rw', authToken: 't' });
    const svc = makeService(prisma);

    await svc.getGroups('u1');

    expect(prisma.contactGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { userId: 'u1' },
            { invites: { some: { invitedEmail: 'me@risa.gov.rw' } } },
          ],
        },
        include: { invites: true },
      }),
    );
  });

  // Review Focus #1 — an invite stored under a different case must still match.
  it('normalises the caller email before matching invites', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: '  Me@Risa.Gov.RW ', authToken: 't' });
    const svc = makeService(prisma);

    await svc.getGroups('u1');

    const where = prisma.contactGroup.findMany.mock.calls[0][0].where;
    expect(where.OR[1]).toEqual({ invites: { some: { invitedEmail: 'me@risa.gov.rw' } } });
  });

  // The getUserEmail regression guard: listing groups is a local DB read and
  // must not require a live Zimbra token.
  it('lists groups when authToken is null', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'me@risa.gov.rw', authToken: null });
    const svc = makeService(prisma);

    await expect(svc.getGroups('u1')).resolves.toEqual([]);
  });

  it('throws NotFound when the user row is missing', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const svc = makeService(prisma);

    await expect(svc.getGroups('u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx jest src/contacts/contacts.groups.spec.ts`
Expected: FAIL — the first two fail on the `where` shape (`{ userId: 'u1' }` only), and "lists groups when authToken is null" passes for the wrong reason (current `getGroups` never reads the user at all). That is expected; Step 3 makes all four meaningful.

- [ ] **Step 3: Implement**

In `apps/api/src/contacts/contacts.service.ts`, add this private helper directly below the existing `getUser`:

```ts
  /**
   * The caller's normalised address, for local ACL reads only.
   *
   * Deliberately NOT `getUser`: that throws when `authToken` is null, which is
   * right before a provider call but wrong here — listing groups is a database
   * read and must keep working when a user's Zimbra token has expired.
   */
  private async getUserEmail(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return user.email.trim().toLowerCase();
  }
```

Then replace `getGroups` entirely:

```ts
  async getGroups(userId: string) {
    const email = await this.getUserEmail(userId);
    return this.prisma.contactGroup.findMany({
      where: {
        OR: [
          { userId },
          { invites: { some: { invitedEmail: email } } },
        ],
      },
      include: { invites: true },
      orderBy: { name: 'asc' },
    });
  }
```

Note the test mocks `user.findUnique` without honouring `select`, which is fine — it returns the whole fixture object and `.email` is present.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx jest src/contacts/contacts.groups.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/contacts/contacts.service.ts apps/api/src/contacts/contacts.groups.spec.ts
git commit -m "feat(api): groups read returns owned and shared, without requiring a mail token"
```

---

### Task 3: Role resolution and role-gated writes

**Files:**
- Modify: `apps/api/src/contacts/contacts.service.ts` (`updateGroup` ~line 369, `deleteGroup` ~line 382)
- Modify: `apps/api/src/contacts/contacts.groups.spec.ts`

**Interfaces:**
- Consumes: `getUserEmail` from Task 2.
- Produces: `private async requireGroupAccess(userId: string, groupId: string, need: 'read' | 'write' | 'own'): Promise<{ group: ContactGroup; isOwner: boolean }>` — throws `NotFoundException('Group not found')` when the caller lacks the required level. Used by Task 4's share endpoints.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/contacts/contacts.groups.spec.ts`:

```ts
describe('ContactsService group writes — role gates', () => {
  const owned = { id: 'g1', userId: 'u1', name: 'Finance', members: [], invites: [] };
  const sharedViewer = {
    id: 'g1', userId: 'owner', name: 'Finance', members: [],
    invites: [{ invitedEmail: 'me@risa.gov.rw', role: 'VIEWER' }],
  };
  const sharedEditor = {
    id: 'g1', userId: 'owner', name: 'Finance', members: [],
    invites: [{ invitedEmail: 'me@risa.gov.rw', role: 'EDITOR' }],
  };

  function svcFor(group: any) {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'me@risa.gov.rw', authToken: 't' });
    prisma.contactGroup.findFirst.mockResolvedValue(group);
    prisma.contactGroup.update.mockResolvedValue({ ...group, name: 'Renamed' });
    prisma.contactGroup.delete.mockResolvedValue(group);
    return { prisma, svc: makeService(prisma) };
  }

  it('lets the owner edit', async () => {
    const { svc, prisma } = svcFor(owned);
    await svc.updateGroup('u1', 'g1', { name: 'Renamed' });
    expect(prisma.contactGroup.update).toHaveBeenCalled();
  });

  it('lets an EDITOR invitee edit', async () => {
    const { svc, prisma } = svcFor(sharedEditor);
    await svc.updateGroup('u1', 'g1', { name: 'Renamed' });
    expect(prisma.contactGroup.update).toHaveBeenCalled();
  });

  it('refuses a VIEWER invitee editing', async () => {
    const { svc, prisma } = svcFor(sharedViewer);
    await expect(svc.updateGroup('u1', 'g1', { name: 'Renamed' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.contactGroup.update).not.toHaveBeenCalled();
  });

  it('refuses a stranger editing', async () => {
    const { svc, prisma } = svcFor(null);
    await expect(svc.updateGroup('u1', 'g1', { name: 'Renamed' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.contactGroup.update).not.toHaveBeenCalled();
  });

  it('lets only the owner delete — an EDITOR cannot', async () => {
    const { svc, prisma } = svcFor(sharedEditor);
    await expect(svc.deleteGroup('u1', 'g1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.contactGroup.delete).not.toHaveBeenCalled();
  });

  it('lets the owner delete', async () => {
    const { svc, prisma } = svcFor(owned);
    await expect(svc.deleteGroup('u1', 'g1')).resolves.toEqual({ success: true });
    expect(prisma.contactGroup.delete).toHaveBeenCalledWith({ where: { id: 'g1' } });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx jest src/contacts/contacts.groups.spec.ts -t "role gates"`
Expected: FAIL — "lets an EDITOR invitee edit" and "refuses a VIEWER invitee editing" fail, because the current `findFirst({ where: { id, userId } })` only ever finds owned groups.

- [ ] **Step 3: Implement the access helper**

Add to `apps/api/src/contacts/contacts.service.ts`, below `getUserEmail`:

```ts
  /**
   * Resolve what the caller may do with a group, or refuse.
   *
   * Refusal is always NotFoundException, never Forbidden — a stranger must not
   * be able to probe whether a group id exists.
   */
  private async requireGroupAccess(
    userId: string,
    groupId: string,
    need: 'read' | 'write' | 'own',
  ) {
    const email = await this.getUserEmail(userId);
    const group = await this.prisma.contactGroup.findFirst({
      where: {
        id: groupId,
        OR: [
          { userId },
          { invites: { some: { invitedEmail: email } } },
        ],
      },
      include: { invites: true },
    });
    if (!group) throw new NotFoundException('Group not found');

    const isOwner = group.userId === userId;
    if (need === 'own' && !isOwner) throw new NotFoundException('Group not found');
    if (need === 'write' && !isOwner) {
      const mine = group.invites.find((i) => i.invitedEmail === email);
      if (mine?.role !== 'EDITOR') throw new NotFoundException('Group not found');
    }
    return { group, isOwner };
  }
```

- [ ] **Step 4: Route the two write paths through it**

Replace the first two lines of `updateGroup`:

```ts
  async updateGroup(userId: string, groupId: string, data: { name?: string; description?: string; members?: { email: string; name?: string }[] }) {
    await this.requireGroupAccess(userId, groupId, 'write');
    return this.prisma.contactGroup.update({
```

(the rest of the method body is unchanged)

Replace the first two lines of `deleteGroup`:

```ts
  async deleteGroup(userId: string, groupId: string): Promise<{ success: boolean }> {
    await this.requireGroupAccess(userId, groupId, 'own');
    await this.prisma.contactGroup.delete({ where: { id: groupId } });
    return { success: true };
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx jest src/contacts/contacts.groups.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/contacts/contacts.service.ts apps/api/src/contacts/contacts.groups.spec.ts
git commit -m "feat(api): gate group edit on EDITOR and delete on ownership"
```

---

### Task 4: Share endpoints

**Files:**
- Create: `apps/api/src/contacts/dto/group-share.dto.ts`
- Modify: `apps/api/src/contacts/contacts.service.ts` (append three methods)
- Modify: `apps/api/src/contacts/contacts.controller.ts` (append three routes)
- Modify: `apps/api/src/contacts/contacts.groups.spec.ts`

**Interfaces:**
- Consumes: `requireGroupAccess` from Task 3.
- Produces:
  - `listShares(userId, groupId): Promise<GroupInvite[]>`
  - `addShare(userId, groupId, data: { email: string; role?: 'VIEWER' | 'EDITOR' }): Promise<GroupInvite>`
  - `removeShare(userId, groupId, inviteId): Promise<{ success: boolean }>`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/contacts/contacts.groups.spec.ts`:

```ts
describe('ContactsService group shares', () => {
  function ownerSvc() {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'me@risa.gov.rw', authToken: 't' });
    prisma.contactGroup.findFirst.mockResolvedValue({ id: 'g1', userId: 'u1', invites: [] });
    prisma.groupInvite.upsert.mockImplementation(({ create }: any) => Promise.resolve({ id: 'i1', ...create }));
    prisma.groupInvite.findFirst.mockResolvedValue({ id: 'i1', groupId: 'g1' });
    prisma.groupInvite.delete.mockResolvedValue({ id: 'i1' });
    return { prisma, svc: makeService(prisma) };
  }

  // Review Focus #1 — normalise on write, so read-side matching can succeed.
  it('stores the invited email trimmed and lowercased', async () => {
    const { svc, prisma } = ownerSvc();
    await svc.addShare('u1', 'g1', { email: '  Alice@Risa.Gov.RW  ' });
    expect(prisma.groupInvite.upsert.mock.calls[0][0].create.invitedEmail).toBe('alice@risa.gov.rw');
  });

  it('defaults a new invite to VIEWER', async () => {
    const { svc, prisma } = ownerSvc();
    await svc.addShare('u1', 'g1', { email: 'alice@risa.gov.rw' });
    expect(prisma.groupInvite.upsert.mock.calls[0][0].create.role).toBe('VIEWER');
  });

  // Review Focus #2 — re-inviting must update the role, not raise P2002.
  it('re-inviting the same email is idempotent and updates the role', async () => {
    const { svc, prisma } = ownerSvc();
    await svc.addShare('u1', 'g1', { email: 'alice@risa.gov.rw', role: 'EDITOR' });
    const call = prisma.groupInvite.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ groupId_invitedEmail: { groupId: 'g1', invitedEmail: 'alice@risa.gov.rw' } });
    expect(call.update).toEqual({ role: 'EDITOR' });
  });

  it('refuses inviting yourself', async () => {
    const { svc, prisma } = ownerSvc();
    await expect(svc.addShare('u1', 'g1', { email: 'ME@risa.gov.rw' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.groupInvite.upsert).not.toHaveBeenCalled();
  });

  it('refuses a non-owner sharing', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'me@risa.gov.rw', authToken: 't' });
    prisma.contactGroup.findFirst.mockResolvedValue({
      id: 'g1', userId: 'owner',
      invites: [{ invitedEmail: 'me@risa.gov.rw', role: 'EDITOR' }],
    });
    const svc = makeService(prisma);
    await expect(svc.addShare('u1', 'g1', { email: 'x@risa.gov.rw' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses revoking an invite belonging to another group', async () => {
    const { svc, prisma } = ownerSvc();
    prisma.groupInvite.findFirst.mockResolvedValue(null);
    await expect(svc.removeShare('u1', 'g1', 'i9')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.groupInvite.delete).not.toHaveBeenCalled();
  });
});
```

Add `BadRequestException` to the import at the top of the spec file:

```ts
import { BadRequestException, NotFoundException } from '@nestjs/common';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx jest src/contacts/contacts.groups.spec.ts -t "group shares"`
Expected: FAIL with `svc.addShare is not a function`.

- [ ] **Step 3: Write the DTO**

Create `apps/api/src/contacts/dto/group-share.dto.ts`. Every field needs a decorator — the global `ValidationPipe({ whitelist: true })` strips anything undecorated:

```ts
import { IsEmail, IsIn, IsOptional } from 'class-validator';

export class AddGroupShareDto {
  @IsEmail({}, { message: 'A valid email address is required' })
  email!: string;

  @IsOptional()
  @IsIn(['VIEWER', 'EDITOR'])
  role?: 'VIEWER' | 'EDITOR';
}
```

- [ ] **Step 4: Implement the three service methods**

Append to `ContactsService` in `apps/api/src/contacts/contacts.service.ts`, after `deleteGroup`:

```ts
  // ── Group sharing ─────────────────────────────────────────────────────────

  async listShares(userId: string, groupId: string) {
    await this.requireGroupAccess(userId, groupId, 'read');
    return this.prisma.groupInvite.findMany({
      where: { groupId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addShare(
    userId: string,
    groupId: string,
    data: { email: string; role?: 'VIEWER' | 'EDITOR' },
  ) {
    await this.requireGroupAccess(userId, groupId, 'own');

    const invitedEmail = data.email.trim().toLowerCase();
    const me = await this.getUserEmail(userId);
    if (invitedEmail === me) {
      throw new BadRequestException('You already own this group');
    }

    const role = data.role ?? 'VIEWER';
    // Upsert rather than create: @@unique([groupId, invitedEmail]) means a
    // second invite to the same person is a role change, not an error.
    return this.prisma.groupInvite.upsert({
      where: { groupId_invitedEmail: { groupId, invitedEmail } },
      update: { role },
      create: { groupId, invitedEmail, invitedBy: userId, role },
    });
  }

  async removeShare(
    userId: string,
    groupId: string,
    inviteId: string,
  ): Promise<{ success: boolean }> {
    await this.requireGroupAccess(userId, groupId, 'own');
    // Scoped by groupId so an invite id from another group cannot be revoked
    // by someone who happens to own a different group.
    const invite = await this.prisma.groupInvite.findFirst({
      where: { id: inviteId, groupId },
    });
    if (!invite) throw new NotFoundException('Share not found');
    await this.prisma.groupInvite.delete({ where: { id: inviteId } });
    return { success: true };
  }
```

Add `BadRequestException` to the `@nestjs/common` import at the top of `contacts.service.ts`:

```ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
```

- [ ] **Step 5: Add the three routes**

In `apps/api/src/contacts/contacts.controller.ts`, append inside the Contact Groups block, after `deleteGroup`:

```ts
  /** GET /contacts/groups/:id/shares — who this group is shared with */
  @Get('groups/:id/shares')
  listShares(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.contactsService.listShares(req.user.sub, id);
  }

  /** POST /contacts/groups/:id/shares — invite someone (owner only) */
  @Post('groups/:id/shares')
  @HttpCode(HttpStatus.OK)
  addShare(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: AddGroupShareDto,
  ) {
    return this.contactsService.addShare(req.user.sub, id, body);
  }

  /** DELETE /contacts/groups/:id/shares/:inviteId — revoke (owner only) */
  @Delete('groups/:id/shares/:inviteId')
  @HttpCode(HttpStatus.OK)
  removeShare(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('inviteId') inviteId: string,
  ) {
    return this.contactsService.removeShare(req.user.sub, id, inviteId);
  }
```

Add the DTO import at the top of the controller:

```ts
import { AddGroupShareDto } from './dto/group-share.dto';
```

These routes are three segments deep (`groups/:id/shares`), so they cannot be swallowed by the existing single-segment `:id` handlers regardless of declaration order.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/api && npx jest src/contacts/contacts.groups.spec.ts`
Expected: PASS, 16 tests.

- [ ] **Step 7: Verify the whole API suite still passes**

Run: `cd apps/api && npx jest`
Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/contacts
git commit -m "feat(api): share a contact group with named colleagues"
```

---

### Task 5: Groups in autocomplete, opt-in

**Files:**
- Modify: `apps/api/src/contacts/contacts.service.ts` (`autocomplete` ~line 300)
- Modify: `apps/api/src/contacts/contacts.controller.ts` (`autocomplete` route ~line 29)
- Create: `apps/api/src/contacts/contacts.autocomplete-groups.spec.ts`

**Interfaces:**
- Consumes: `getUserEmail` (Task 2).
- Produces: `autocomplete(userId, query, opts?: { includeGroups?: boolean })` now returns a union array. Group entries have the shape `{ kind: 'group', groupId, display, memberCount, members }`; address entries are unchanged and carry **no** `kind` field.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/contacts/contacts.autocomplete-groups.spec.ts`:

```ts
import { ContactsService } from './contacts.service';

function makePrisma(groups: any[] = []) {
  return {
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1', email: 'me@risa.gov.rw', authToken: 't', provider: 'zimbra', zimbraHost: 'h' }) },
    contactGroup: { findMany: jest.fn().mockResolvedValue(groups) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  } as any;
}

const makeResolver = () => ({
  forUser: () => ({
    autoCompleteContacts: jest.fn().mockResolvedValue([{ email: 'finance.desk@risa.gov.rw', display: 'Finance Desk' }]),
    searchGal: jest.fn().mockResolvedValue([]),
  }),
}) as any;

const FINANCE = {
  id: 'g1', name: 'Finance Team',
  members: [{ email: 'a@risa.gov.rw', name: 'A' }, { email: 'b@risa.gov.rw' }],
};

describe('ContactsService.autocomplete — groups', () => {
  it('returns no groups unless asked', async () => {
    const prisma = makePrisma([FINANCE]);
    const svc = new ContactsService(prisma, makeResolver());

    const out = await svc.autocomplete('u1', 'fin');

    expect(out.some((s: any) => s.kind === 'group')).toBe(false);
    expect(prisma.contactGroup.findMany).not.toHaveBeenCalled();
  });

  it('returns a matching group first when asked', async () => {
    const prisma = makePrisma([FINANCE]);
    const svc = new ContactsService(prisma, makeResolver());

    const out = await svc.autocomplete('u1', 'fin', { includeGroups: true });

    expect(out[0]).toEqual({
      kind: 'group',
      groupId: 'g1',
      display: 'Finance Team',
      memberCount: 2,
      members: [{ email: 'a@risa.gov.rw', name: 'A' }, { email: 'b@risa.gov.rw' }],
    });
    // Address suggestions still follow, unchanged in shape.
    expect(out[1]).toEqual({ email: 'finance.desk@risa.gov.rw', display: 'Finance Desk' });
  });

  it('matches group names case-insensitively', async () => {
    const prisma = makePrisma([FINANCE]);
    const svc = new ContactsService(prisma, makeResolver());

    const out = await svc.autocomplete('u1', 'FINANCE', { includeGroups: true });

    expect(out[0]).toMatchObject({ kind: 'group', groupId: 'g1' });
  });

  it('still returns addresses when the group lookup throws', async () => {
    const prisma = makePrisma([FINANCE]);
    prisma.contactGroup.findMany.mockRejectedValue(new Error('db down'));
    const svc = new ContactsService(prisma, makeResolver());

    const out = await svc.autocomplete('u1', 'fin', { includeGroups: true });

    expect(out).toEqual([{ email: 'finance.desk@risa.gov.rw', display: 'Finance Desk' }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx jest src/contacts/contacts.autocomplete-groups.spec.ts`
Expected: FAIL — "returns a matching group first when asked" fails because `out[0]` is the address suggestion.

- [ ] **Step 3: Implement**

In `apps/api/src/contacts/contacts.service.ts`, add this type above the class:

```ts
export type AutocompleteSuggestion =
  | { email: string; display: string }
  | {
      kind: 'group';
      groupId: string;
      display: string;
      memberCount: number;
      members: Array<{ email: string; name?: string }>;
    };
```

Add the private group matcher below `autocompleteFromHistory`:

```ts
  /**
   * Groups the caller may send to whose name matches the query.
   *
   * Never throws — a failure here must degrade to address-only suggestions
   * rather than breaking the recipient field.
   */
  private async autocompleteGroups(
    userId: string,
    query: string,
  ): Promise<AutocompleteSuggestion[]> {
    try {
      const email = await this.getUserEmail(userId);
      const groups = await this.prisma.contactGroup.findMany({
        where: {
          name: { contains: query, mode: 'insensitive' },
          OR: [
            { userId },
            { invites: { some: { invitedEmail: email } } },
          ],
        },
        orderBy: { name: 'asc' },
        take: 5,
      });
      return groups.map((g) => {
        const members = (Array.isArray(g.members) ? g.members : []) as Array<{
          email: string;
          name?: string;
        }>;
        return {
          kind: 'group' as const,
          groupId: g.id,
          display: g.name,
          memberCount: members.length,
          members,
        };
      });
    } catch (err: any) {
      console.warn(`autocompleteGroups: ${err?.message ?? err}`);
      return [];
    }
  }
```

Then change the `autocomplete` signature and its return. Replace the opening lines:

```ts
  async autocomplete(
    userId: string,
    query: string,
    opts: { includeGroups?: boolean } = {},
  ): Promise<AutocompleteSuggestion[]> {
    const q = (query ?? '').trim();
    if (!q) return [];
```

and replace the final `return merged.slice(0, 20);` with:

```ts
    // Groups rank above addresses — someone typing their group's name wants the
    // group — and sit outside the 20-address cap so a match is never crowded out.
    const groups = opts.includeGroups
      ? await this.autocompleteGroups(userId, q)
      : [];
    return [...groups, ...merged.slice(0, 20)];
```

The test's mock resolver has no `searchGal` failure path, and `$queryRaw` returns `[]`, so history contributes nothing — which is what makes the ordering assertion exact.

- [ ] **Step 4: Wire the controller flag**

In `apps/api/src/contacts/contacts.controller.ts`, replace the `autocomplete` handler:

```ts
  @Get('autocomplete')
  autocomplete(
    @Req() req: AuthenticatedRequest,
    @Query('q') q: string,
    @Query('groups') groups: string,
  ) {
    return this.contactsService.autocomplete(req.user.sub, q ?? '', {
      includeGroups: groups === 'true',
    });
  }
```

Remove the now-wrong explicit `Promise<Array<{ email: string; display: string }>>` return annotation from that handler — the service's `AutocompleteSuggestion[]` is the real type.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx jest src/contacts/contacts.autocomplete-groups.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Verify no API regressions and that types still compile**

Run: `cd apps/api && npx jest && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/contacts
git commit -m "feat(api): offer contact groups in recipient autocomplete behind a flag"
```

---

### Task 6: Web API client and the `includeGroups` hook option

**Files:**
- Modify: `apps/web/lib/api.ts` (`contacts.autocomplete` ~line 115, `contacts.groups` ~line 142)
- Modify: `apps/web/hooks/useContactSuggestions.ts`
- Create: `apps/web/hooks/useContactSuggestions.test.tsx`

**Interfaces:**
- Consumes: the API shapes from Tasks 4 and 5.
- Produces:
  - `export type ContactSuggestion = ContactAddressSuggestion | ContactGroupSuggestion` with `isGroupSuggestion(s): s is ContactGroupSuggestion` as the narrowing helper.
  - `useContactSuggestions(query, { exclude?, includeGroups? })` — `includeGroups` defaults to `false`.
  - `api.contacts.groups.shares.list/add/remove`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/hooks/useContactSuggestions.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useContactSuggestions } from './useContactSuggestions';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: { contacts: { autocomplete: vi.fn() } },
}));

const autocomplete = api.contacts.autocomplete as unknown as ReturnType<typeof vi.fn>;

const GROUP = {
  kind: 'group' as const,
  groupId: 'g1',
  display: 'Finance Team',
  memberCount: 2,
  members: [{ email: 'a@risa.gov.rw' }, { email: 'b@risa.gov.rw' }],
};
const ADDRESS = { email: 'alice@risa.gov.rw', display: 'Alice' };

describe('useContactSuggestions', () => {
  beforeEach(() => {
    autocomplete.mockReset();
    autocomplete.mockResolvedValue([GROUP, ADDRESS]);
  });

  // Review Focus #4 — Advanced Search's existing test asserts the client is
  // called with exactly one argument. The default path must not change arity.
  it('calls the client with only the query when groups are not requested', async () => {
    renderHook(() => useContactSuggestions('fin'));
    await waitFor(() => expect(autocomplete).toHaveBeenCalled(), { timeout: 2000 });
    expect(autocomplete.mock.calls[0]).toEqual(['fin']);
  });

  it('asks for groups when includeGroups is set', async () => {
    renderHook(() => useContactSuggestions('fin', { includeGroups: true }));
    await waitFor(() => expect(autocomplete).toHaveBeenCalled(), { timeout: 2000 });
    expect(autocomplete.mock.calls[0]).toEqual(['fin', { includeGroups: true }]);
  });

  // Review Focus #3 — a group suggestion has no `email`; the exclude filter
  // must neither crash nor drop it.
  it('never excludes a group, even when its members are already chips', async () => {
    const { result } = renderHook(() =>
      useContactSuggestions('fin', {
        includeGroups: true,
        exclude: ['alice@risa.gov.rw', 'a@risa.gov.rw'],
      }),
    );
    await waitFor(() => expect(result.current.suggestions.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(result.current.suggestions).toEqual([GROUP]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run hooks/useContactSuggestions.test.tsx`
Expected: FAIL — "asks for groups when includeGroups is set" fails with the call being `['fin']`.

- [ ] **Step 3: Update the API client**

In `apps/web/lib/api.ts`, replace the `autocomplete` method:

```ts
    /**
     * Autocomplete email addresses / names from Zimbra contacts + GAL.
     * Pass `includeGroups` to also receive the caller's contact groups — only
     * the compose recipient field wants these; single-address search fields
     * must not offer a group.
     */
    autocomplete: (
      q: string,
      opts?: { includeGroups?: boolean },
    ): Promise<ContactSuggestionDTO[]> => {
      if (USE_MOCK) return delay<ContactSuggestionDTO[]>([]);
      const qs = new URLSearchParams({ q });
      if (opts?.includeGroups) qs.set('groups', 'true');
      return request<ContactSuggestionDTO[]>(`/contacts/autocomplete?${qs.toString()}`);
    },
```

Add this type near the top of `apps/web/lib/api.ts`, beside the other exported types:

```ts
export type ContactSuggestionDTO =
  | { kind?: undefined; email: string; display: string }
  | {
      kind: 'group';
      groupId: string;
      display: string;
      memberCount: number;
      members: Array<{ email: string; name?: string }>;
    };
```

Then add the `shares` block inside `contacts.groups`, after `delete`:

```ts
      shares: {
        list: (groupId: string) => {
          if (USE_MOCK) return delay<any[]>([]);
          return request<any[]>(`/contacts/groups/${groupId}/shares`);
        },
        add: (groupId: string, data: { email: string; role?: 'VIEWER' | 'EDITOR' }) => {
          if (USE_MOCK) return delay({ id: `i-${Date.now()}`, ...data });
          return request<any>(`/contacts/groups/${groupId}/shares`, {
            method: 'POST',
            body: JSON.stringify(data),
          });
        },
        remove: (groupId: string, inviteId: string) => {
          if (USE_MOCK) return delay({ success: true });
          return request<{ success: boolean }>(
            `/contacts/groups/${groupId}/shares/${inviteId}`,
            { method: 'DELETE' },
          );
        },
      },
```

- [ ] **Step 4: Update the hook**

In `apps/web/hooks/useContactSuggestions.ts`, replace the exported type and add the guard:

```ts
export interface ContactAddressSuggestion {
  kind?: undefined;
  email: string;
  display: string;
}

export interface ContactGroupSuggestion {
  kind: 'group';
  groupId: string;
  display: string;
  memberCount: number;
  members: Array<{ email: string; name?: string }>;
}

export type ContactSuggestion = ContactAddressSuggestion | ContactGroupSuggestion;

export const isGroupSuggestion = (s: ContactSuggestion): s is ContactGroupSuggestion =>
  s.kind === 'group';
```

Change the signature:

```ts
export function useContactSuggestions(
  query: string,
  options: { exclude?: string[]; includeGroups?: boolean } = {},
) {
  const { exclude, includeGroups } = options;
```

Replace the fetch call inside the debounce, keeping the one-argument form when groups are not wanted so Advanced Search's existing assertion holds:

```ts
        const results = await api.contacts.autocomplete(
          ...(includeGroups
            ? ([query.trim(), { includeGroups: true }] as const)
            : ([query.trim()] as const)),
        );
```

Replace the `suggestions` memo — groups are never excluded, because selecting one is still useful when only some members are already chips:

```ts
  const suggestions = useMemo(() => {
    if (!exclude || exclude.length === 0) return fetched;
    const skip = new Set(exclude.map((e) => e.trim().toLowerCase()));
    return fetched.filter(
      (s) => isGroupSuggestion(s) || !skip.has(s.email.trim().toLowerCase()),
    );
  }, [fetched, exclude]);
```

Add `includeGroups` to the effect's dependency array alongside `query`:

```ts
  }, [query, includeGroups]);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run hooks/useContactSuggestions.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 6: Verify Advanced Search did not regress**

Run: `cd apps/web && npx vitest run components/mail/EmailAutocompleteInput.test.tsx components/mail/AdvancedSearchPanel.test.tsx`
Expected: PASS — in particular `expect(autocomplete).toHaveBeenCalledWith('al')` must still hold.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/api.ts apps/web/hooks/useContactSuggestions.ts apps/web/hooks/useContactSuggestions.test.tsx
git commit -m "feat(web): opt-in group suggestions in the contact suggestions hook"
```

---

### Task 7: Expand a group into chips in compose

**Files:**
- Modify: `apps/web/components/mail/EmailChipInput.tsx`
- Create: `apps/web/components/mail/EmailChipInputGroups.test.tsx`

**Interfaces:**
- Consumes: `ContactSuggestion`, `isGroupSuggestion`, `useContactSuggestions` from Task 6.
- Produces: no new exports — `EmailChipInput`'s public props are unchanged.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/components/mail/EmailChipInputGroups.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { EmailChipInput } from './EmailChipInput';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: { contacts: { autocomplete: vi.fn() } },
}));

const autocomplete = api.contacts.autocomplete as unknown as ReturnType<typeof vi.fn>;

const group = (members: Array<{ email: string; name?: string }>) => ({
  kind: 'group' as const,
  groupId: 'g1',
  display: 'Finance Team',
  memberCount: members.length,
  members,
});

function Harness({ initial = [] as string[] }) {
  const [value, setValue] = useState<string[]>(initial);
  return <EmailChipInput label="To" value={value} onChange={setValue} placeholder="recipients@example.com" />;
}

const typeQuery = async (text = 'fin') => {
  fireEvent.change(screen.getByPlaceholderText('recipients@example.com'), { target: { value: text } });
  await waitFor(() => expect(autocomplete).toHaveBeenCalled(), { timeout: 2000 });
};

const pickGroup = async () => {
  const opt = await screen.findByText(/Finance Team/);
  fireEvent.mouseDown(opt);
};

describe('EmailChipInput — groups', () => {
  beforeEach(() => autocomplete.mockReset());

  it('requests group suggestions', async () => {
    autocomplete.mockResolvedValue([]);
    render(<Harness />);
    await typeQuery();
    expect(autocomplete.mock.calls[0]).toEqual(['fin', { includeGroups: true }]);
  });

  it('shows a group with its member count', async () => {
    autocomplete.mockResolvedValue([group([{ email: 'a@risa.gov.rw' }, { email: 'b@risa.gov.rw' }])]);
    render(<Harness />);
    await typeQuery();
    expect(await screen.findByText(/Finance Team/)).toBeInTheDocument();
    expect(screen.getByText(/2 members/)).toBeInTheDocument();
  });

  it('expands a group into one chip per member', async () => {
    autocomplete.mockResolvedValue([group([{ email: 'a@risa.gov.rw' }, { email: 'b@risa.gov.rw' }])]);
    render(<Harness />);
    await typeQuery();
    await pickGroup();
    expect(await screen.findByText('a@risa.gov.rw')).toBeInTheDocument();
    expect(screen.getByText('b@risa.gov.rw')).toBeInTheDocument();
  });

  // Review Focus #5 — blanks, duplicates, and case variants must not become chips.
  it('drops blank and duplicate members, case-insensitively', async () => {
    autocomplete.mockResolvedValue([
      group([
        { email: 'a@risa.gov.rw' },
        { email: '  ' },
        { email: 'A@RISA.GOV.RW' },
        { email: 'b@risa.gov.rw' },
      ]),
    ]);
    render(<Harness initial={['b@risa.gov.rw']} />);
    await typeQuery();
    await pickGroup();
    await waitFor(() => expect(screen.getByText('a@risa.gov.rw')).toBeInTheDocument());
    expect(screen.getAllByText(/@risa\.gov\.rw/)).toHaveLength(2); // b (pre-existing) + a
  });

  it('says so when the group is empty instead of doing nothing', async () => {
    autocomplete.mockResolvedValue([group([])]);
    render(<Harness />);
    await typeQuery();
    await pickGroup();
    expect(await screen.findByText(/has no members/i)).toBeInTheDocument();
  });

  it('caps expansion at 50 chips and collapses the rest', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ email: `u${i}@risa.gov.rw` }));
    autocomplete.mockResolvedValue([group(many)]);
    render(<Harness />);
    await typeQuery();
    await pickGroup();
    expect(await screen.findByText('+10 more')).toBeInTheDocument();
    expect(screen.getByText('u0@risa.gov.rw')).toBeInTheDocument();
    expect(screen.queryByText('u55@risa.gov.rw')).not.toBeInTheDocument();
  });

  it('expands the remainder when the +N more chip is clicked', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ email: `u${i}@risa.gov.rw` }));
    autocomplete.mockResolvedValue([group(many)]);
    render(<Harness />);
    await typeQuery();
    await pickGroup();
    fireEvent.click(await screen.findByText('+10 more'));
    expect(await screen.findByText('u55@risa.gov.rw')).toBeInTheDocument();
    expect(screen.queryByText('+10 more')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run components/mail/EmailChipInputGroups.test.tsx`
Expected: FAIL — the first test fails because the call is `['fin']`.

- [ ] **Step 3: Implement**

In `apps/web/components/mail/EmailChipInput.tsx`, update the import:

```tsx
import { useContactSuggestions, isGroupSuggestion, type ContactSuggestion } from '@/hooks/useContactSuggestions';
import { toast } from 'sonner';
import { Users } from 'lucide-react';
```

(`sonner`'s `toast` is already the project's toast — it is used throughout `contacts/page.tsx`.)

Add the cap constant above the component:

```tsx
/** Beyond this many, expanding a group would bury the compose form in chips. */
const MAX_EXPANDED_MEMBERS = 50;
```

Add overflow state inside the component, beside the existing `input` state:

```tsx
  const [overflow, setOverflow] = useState<string[]>([]);
```

Request groups from the hook:

```tsx
  const { suggestions, loading: loadingSuggestions, clear } = useContactSuggestions(input, {
    exclude: value,
    includeGroups: true,
  });
```

Replace `selectSuggestion` with a version that branches on the suggestion kind:

```tsx
  const selectSuggestion = (s: ContactSuggestion) => {
    if (isGroupSuggestion(s)) {
      expandGroup(s.members, s.display);
      setInput(''); closeSuggestions(); inputRef.current?.focus();
      return;
    }
    if (!value.includes(s.email)) onChange([...value, s.email]);
    setInput(''); closeSuggestions(); inputRef.current?.focus();
  };

  /**
   * A group becomes ordinary chips — nothing downstream remembers it came from
   * a group, which is what lets the sender drop one person for one message.
   */
  const expandGroup = (members: Array<{ email: string }>, groupName: string) => {
    const seen = new Set(value.map((v) => v.trim().toLowerCase()));
    const fresh: string[] = [];
    for (const m of members) {
      const email = (m.email ?? '').trim();
      if (!email) continue;
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(email);
    }
    if (fresh.length === 0) {
      toast.info(`"${groupName}" has no members to add`);
      return;
    }
    const head = fresh.slice(0, MAX_EXPANDED_MEMBERS);
    const tail = fresh.slice(MAX_EXPANDED_MEMBERS);
    onChange([...value, ...head]);
    if (tail.length > 0) setOverflow((prev) => [...prev, ...tail]);
  };

  const expandOverflow = () => {
    const seen = new Set(value.map((v) => v.trim().toLowerCase()));
    const rest = overflow.filter((e) => !seen.has(e.trim().toLowerCase()));
    setOverflow([]);
    if (rest.length > 0) onChange([...value, ...rest]);
  };
```

Render the overflow chip immediately after the `value.map(...)` chip list, still inside the chip container div:

```tsx
        {overflow.length > 0 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); expandOverflow(); }}
            className="inline-flex items-center gap-1 px-2 py-0.5 bg-muted border border-border/60 text-muted-foreground text-xs rounded-full hover:bg-muted/70"
          >
            +{overflow.length} more
          </button>
        )}
```

Finally, replace the dropdown `<li>` body so a group renders distinctly. The existing list keys on `s.email`, which a group does not have:

```tsx
              {suggestions.map((s, i) => (
                <li key={isGroupSuggestion(s) ? `g:${s.groupId}` : s.email}>
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); selectSuggestion(s); }}
                    className={`w-full text-left px-3 py-2 flex flex-col gap-0.5 transition-colors ${i === activeIdx ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/60 text-foreground'}`}
                  >
                    {isGroupSuggestion(s) ? (
                      <>
                        <span className="text-xs font-medium leading-tight truncate flex items-center gap-1.5">
                          <Users className="w-3 h-3 text-primary shrink-0" />{s.display}
                        </span>
                        <span className="text-xs leading-tight text-muted-foreground/60">
                          {s.memberCount} {s.memberCount === 1 ? 'member' : 'members'}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="text-xs font-medium leading-tight truncate">{s.display !== s.email ? s.display : ''}</span>
                        <span className={`text-xs leading-tight truncate ${s.display !== s.email ? 'text-muted-foreground/60' : 'font-medium'}`}>{s.email}</span>
                      </>
                    )}
                  </button>
                </li>
              ))}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run components/mail/EmailChipInputGroups.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify compose did not regress**

Run: `cd apps/web && npx vitest run components/mail`
Expected: PASS — `ComposeModal.test.tsx` and the existing chip/autocomplete tests unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/mail/EmailChipInput.tsx apps/web/components/mail/EmailChipInputGroups.test.tsx
git commit -m "feat(web): pick a group in compose and get its members as chips"
```

---

### Task 8: Sharing UI in the Groups tab

**Files:**
- Modify: `apps/web/app/(app)/contacts/page.tsx` (group detail pane; group state block ~line 155-168)
- Create: `apps/web/components/contacts/GroupSharePanel.tsx`
- Create: `apps/web/components/contacts/GroupSharePanel.test.tsx`

**Interfaces:**
- Consumes: `api.contacts.groups.shares.*` from Task 6.
- Produces: `<GroupSharePanel groupId={string} isOwner={boolean} />` — a self-contained panel that loads, adds, and revokes shares. It owns its own data fetching so the contacts page does not grow another async block.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/components/contacts/GroupSharePanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GroupSharePanel } from './GroupSharePanel';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: { contacts: { groups: { shares: { list: vi.fn(), add: vi.fn(), remove: vi.fn() } } } },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const shares = api.contacts.groups.shares as any;

describe('GroupSharePanel', () => {
  beforeEach(() => {
    shares.list.mockReset(); shares.add.mockReset(); shares.remove.mockReset();
    shares.list.mockResolvedValue([{ id: 'i1', invitedEmail: 'alice@risa.gov.rw', role: 'VIEWER' }]);
    shares.add.mockResolvedValue({ id: 'i2', invitedEmail: 'bob@risa.gov.rw', role: 'VIEWER' });
    shares.remove.mockResolvedValue({ success: true });
  });

  it('lists who the group is shared with', async () => {
    render(<GroupSharePanel groupId="g1" isOwner />);
    expect(await screen.findByText('alice@risa.gov.rw')).toBeInTheDocument();
  });

  it('invites someone', async () => {
    render(<GroupSharePanel groupId="g1" isOwner />);
    await screen.findByText('alice@risa.gov.rw');
    fireEvent.change(screen.getByPlaceholderText(/colleague@/i), { target: { value: 'bob@risa.gov.rw' } });
    fireEvent.click(screen.getByRole('button', { name: /share/i }));
    await waitFor(() =>
      expect(shares.add).toHaveBeenCalledWith('g1', { email: 'bob@risa.gov.rw', role: 'VIEWER' }),
    );
    expect(await screen.findByText('bob@risa.gov.rw')).toBeInTheDocument();
  });

  it('revokes a share', async () => {
    render(<GroupSharePanel groupId="g1" isOwner />);
    await screen.findByText('alice@risa.gov.rw');
    fireEvent.click(screen.getByRole('button', { name: /revoke alice@risa.gov.rw/i }));
    await waitFor(() => expect(shares.remove).toHaveBeenCalledWith('g1', 'i1'));
    await waitFor(() => expect(screen.queryByText('alice@risa.gov.rw')).not.toBeInTheDocument());
  });

  it('hides the invite form from a non-owner but still lists shares', async () => {
    render(<GroupSharePanel groupId="g1" isOwner={false} />);
    expect(await screen.findByText('alice@risa.gov.rw')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/colleague@/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /revoke/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run components/contacts/GroupSharePanel.test.tsx`
Expected: FAIL — cannot resolve `./GroupSharePanel`.

- [ ] **Step 3: Implement the panel**

Create `apps/web/components/contacts/GroupSharePanel.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { X, Loader2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

interface Share {
  id: string;
  invitedEmail: string;
  role: 'VIEWER' | 'EDITOR';
}

/**
 * Who a group is shared with. Only the owner may invite or revoke; everyone
 * with access can see the list, so it is clear who else can send to it.
 */
export function GroupSharePanel({ groupId, isOwner }: { groupId: string; isOwner: boolean }) {
  const [shares, setShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'VIEWER' | 'EDITOR'>('VIEWER');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setShares((await api.contacts.groups.shares.list(groupId)) as Share[]);
    } catch (err: any) {
      toast.error('Failed to load sharing', { description: err?.message });
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const created = (await api.contacts.groups.shares.add(groupId, { email: trimmed, role })) as Share;
      // Upsert on the server, so replace any existing row for this address.
      setShares((prev) => [
        ...prev.filter((s) => s.invitedEmail.toLowerCase() !== created.invitedEmail.toLowerCase()),
        created,
      ]);
      setEmail('');
      toast.success(`Shared with ${created.invitedEmail}`);
    } catch (err: any) {
      toast.error('Could not share the group', { description: err?.message });
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (share: Share) => {
    try {
      await api.contacts.groups.shares.remove(groupId, share.id);
      setShares((prev) => prev.filter((s) => s.id !== share.id));
      toast.success(`Removed ${share.invitedEmail}`);
    } catch (err: any) {
      toast.error('Could not remove the share', { description: err?.message });
    }
  };

  return (
    <div className="mt-6 border-t border-border/50 pt-4">
      <h3 className="text-xs font-medium text-muted-foreground/60 uppercase tracking-wider mb-3">
        Shared with
      </h3>

      {loading && shares.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground/50">
          <Loader2 className="w-3 h-3 animate-spin" />Loading…
        </div>
      ) : shares.length === 0 ? (
        <p className="text-xs text-muted-foreground/50">Not shared with anyone yet</p>
      ) : (
        <ul className="flex flex-col gap-1.5 mb-3">
          {shares.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{s.invitedEmail}</span>
              <span className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground/60">
                  {s.role === 'EDITOR' ? 'Can edit' : 'Can send'}
                </span>
                {isOwner && (
                  <button
                    type="button"
                    aria-label={`Revoke ${s.invitedEmail}`}
                    onClick={() => handleRemove(s)}
                    className="text-muted-foreground/50 hover:text-destructive"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {isOwner && (
        <div className="flex items-center gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
            placeholder="colleague@risa.gov.rw"
            className="flex-1 min-w-0 px-3 py-1.5 bg-muted/30 border border-border/50 rounded-lg text-sm outline-none focus:border-primary/50"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as 'VIEWER' | 'EDITOR')}
            aria-label="Permission"
            className="px-2 py-1.5 bg-muted/30 border border-border/50 rounded-lg text-xs outline-none"
          >
            <option value="VIEWER">Can send</option>
            <option value="EDITOR">Can edit</option>
          </select>
          <button
            type="button"
            onClick={handleAdd}
            disabled={saving || !email.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
            Share
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run components/contacts/GroupSharePanel.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Mount the panel in the Groups tab**

In `apps/web/app/(app)/contacts/page.tsx`:

Add the import beside the other component imports:

```tsx
import { GroupSharePanel } from '@/components/contacts/GroupSharePanel';
```

Extend the local `ContactGroup` interface (~line 50) so ownership is readable from the list payload, which now includes invites:

```tsx
interface ContactGroup {
  id: string;
  name: string;
  description?: string | null;
  members: Array<{ email: string; name?: string }>;
  userId?: string;
  invites?: Array<{ id: string; invitedEmail: string; role: 'VIEWER' | 'EDITOR' }>;
}
```

Add the current user's id near the other store reads at the top of the component, then a helper below the group state block:

```tsx
  const currentUserId = useAuthStore((s) => s.user?.id);
  const isGroupOwner = (g: ContactGroup | null) =>
    !!g && (g.userId === undefined || g.userId === currentUserId);
```

If the page does not already read `useAuthStore` with a `user` field, check what the auth store exposes and use the equivalent id accessor — do not invent one.

Render the panel at the end of the group detail pane, inside the branch that shows `selectedGroup` in `'view'` mode:

```tsx
            {selectedGroup && groupMode === 'view' && (
              <GroupSharePanel groupId={selectedGroup.id} isOwner={isGroupOwner(selectedGroup)} />
            )}
```

Finally, gate the group's Edit and Delete buttons so a VIEWER does not see controls the server will refuse. Find the buttons that call `openEditGroup(g)` and `handleDeleteGroup(g)` and wrap each:

```tsx
            {isGroupOwner(selectedGroup) && (/* existing Delete button */)}
```

Edit stays visible for an EDITOR, so guard it on role rather than ownership:

```tsx
  const canEditGroup = (g: ContactGroup | null) =>
    isGroupOwner(g) ||
    !!g?.invites?.some((i) => i.role === 'EDITOR');
```

- [ ] **Step 6: Run the contacts page tests and typecheck**

Run: `cd apps/web && npx vitest run && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/contacts apps/web/app/\(app\)/contacts/page.tsx
git commit -m "feat(web): share a group with colleagues from the Groups tab"
```

---

### Task 9: "Email this group"

**Files:**
- Create: `apps/web/lib/groupCompose.ts`
- Create: `apps/web/lib/groupCompose.test.ts`
- Modify: `apps/web/app/(app)/mail/page.tsx` (compose state block ~line 324-330)
- Modify: `apps/web/app/(app)/contacts/page.tsx` (group detail actions)

**Interfaces:**
- Consumes: `ComposeModal`'s existing `initialTo?: string[]` prop (`ComposeModal.tsx:102`), already wired to `composeDraftProps?.to` at `mail/page.tsx:1830`.
- Produces: `composeUrlForGroup(members: Array<{ email: string }>): string`.

**Context the implementer needs:** the mail page has **no** URL-based compose prefill today. `composeDraftProps` is internal state set from reply/forward/draft handlers only, and `useSearchParams` is not imported anywhere in that file. This task adds the reader. It reads `window.location.search` inside an effect rather than calling `useSearchParams()`, because `useSearchParams` forces a Suspense boundary during prerendering in Next.js 16 and this page has none — adding one is a larger change than this task should carry.

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/groupCompose.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { composeUrlForGroup } from './groupCompose';

describe('composeUrlForGroup', () => {
  it('puts de-duplicated member addresses in the to parameter', () => {
    const url = composeUrlForGroup([
      { email: 'a@risa.gov.rw' },
      { email: 'A@RISA.GOV.RW' },
      { email: '  ' },
      { email: 'b@risa.gov.rw' },
    ]);
    expect(url).toBe('/mail?compose=1&to=a%40risa.gov.rw%2Cb%40risa.gov.rw');
  });

  it('caps at 50 addresses', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ email: `u${i}@risa.gov.rw` }));
    const url = composeUrlForGroup(many);
    expect(decodeURIComponent(url).split(',')).toHaveLength(50);
  });

  it('returns a plain compose url for an empty group', () => {
    expect(composeUrlForGroup([])).toBe('/mail?compose=1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run lib/groupCompose.test.ts`
Expected: FAIL — cannot resolve `./groupCompose`.

- [ ] **Step 3: Implement the URL builder**

Create `apps/web/lib/groupCompose.ts`:

```ts
/** Matches EmailChipInput's expansion cap, so both paths behave the same. */
const MAX_EXPANDED_MEMBERS = 50;

/**
 * Compose URL that opens a new message addressed to a group's members.
 * Members are a snapshot of addresses, so this is plain de-duplication —
 * nothing downstream needs to know the group existed.
 */
export function composeUrlForGroup(members: Array<{ email: string }>): string {
  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const m of members) {
    const email = (m.email ?? '').trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(email);
    if (addresses.length >= MAX_EXPANDED_MEMBERS) break;
  }
  if (addresses.length === 0) return '/mail?compose=1';
  const qs = new URLSearchParams({ compose: '1', to: addresses.join(',') });
  return `/mail?${qs.toString()}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run lib/groupCompose.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Teach the mail page to honour the parameters**

In `apps/web/app/(app)/mail/page.tsx`, add this effect directly below the `composeDraftProps` state declaration (~line 330). It runs once on mount, opens compose with the addresses, and strips the parameters so a refresh or a back-navigation does not reopen the same message:

```tsx
  // Compose prefill handed over by another page (Contacts → "Email this group").
  // Reads location directly rather than useSearchParams(), which would require a
  // Suspense boundary this page does not have.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('compose') !== '1') return;
    const to = (params.get('to') ?? '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    setComposeDraftProps(to.length > 0 ? { to } : null);
    setComposeMode('new');
    setComposeOpen(true);
    window.history.replaceState({}, '', '/mail');
  }, []);
```

`composeDraftProps` is typed as an object literal with optional fields, so `{ to }` satisfies it. If TypeScript complains that other fields are required, widen the assignment to `{ to } as typeof composeDraftProps` rather than changing the state type.

- [ ] **Step 6: Wire the button**

In `apps/web/app/(app)/contacts/page.tsx`, add the import:

```tsx
import { composeUrlForGroup } from '@/lib/groupCompose';
```

Add an "Email this group" button to the group detail pane's action row, beside Edit:

```tsx
            <button
              type="button"
              onClick={() => router.push(composeUrlForGroup(selectedGroup.members))}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium"
            >
              <Mail className="w-3 h-3" />Email this group
            </button>
```

Ensure `Mail` is in the `lucide-react` import list at the top of the file; add it if it is not.

- [ ] **Step 7: Verify end to end**

Run: `cd apps/web && npx vitest run && npx tsc --noEmit`
Expected: PASS, no type errors.

Run: `cd apps/api && npx jest`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/groupCompose.ts apps/web/lib/groupCompose.test.ts apps/web/app/\(app\)/contacts/page.tsx apps/web/app/\(app\)/mail/page.tsx
git commit -m "feat(web): email a whole group from the Groups tab"
```

---

## Done

After Task 9, the full flow works: create a group, share it with colleagues, type its name in To: and get editable chips, or mail it straight from Contacts.

**Before deploying:** run both suites and a production build.

```bash
cd apps/api && npx jest && cd ../web && npx vitest run && npx tsc --noEmit && npm run build
```

**Live smoke on both VMs** (`10.10.94.154`, `10.10.94.155`) after deploy, and the migration must be applied on both. Per the standing rule, **no real external recipients in test sends** — group members in testing are internal test addresses only.
