# Blocked & Allowed Senders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user block or allow-list sender addresses/domains from Settings, and automatically move mail from blocked senders into the Spam/Junk folder the next time it's synced.

**Architecture:** New `SenderRule` Prisma model (local Postgres only — no Zimbra SOAP call, matching the existing unenforced `MailRule` precedent for storage, but this one *is* enforced). A pure `matchSenderRule()` function resolves ALLOW-over-BLOCK precedence for exact addresses and `@domain.com` wildcards. Enforcement hooks into `MailService.getMessages` — the one place this codebase already observes "a message exists" (see Context below) — and reuses the existing Zimbra `moveMessage` SOAP call to file blocked mail into `/Junk`.

**Tech Stack:** NestJS 11, Prisma 7/PostgreSQL, Jest (api), Next.js 16, Vitest + React Testing Library (web).

**Spec:** No separate spec doc exists for this feature — requirements are captured inline in the Context section below, derived from a live comparison against the RISA Zimbra Modern UI (see the published gap-analysis artifact from this conversation).

## Context (why this is shaped the way it is)

This app does **not** have a mail-sync job. `MailService.getMessages` (`apps/api/src/mail/mail.service.ts:104`) fetches messages live from Zimbra via SOAP on every folder-open request, then **upserts** them into the local `Message` table as a read-through cache — that upsert is the only point in the entire backend where a message is "observed." There is no ingestion pipeline, no cron, no webhook. This plan's enforcement step therefore runs inside that existing upsert loop, not in some new sync job.

There is also **no rule-evaluation engine anywhere** in this codebase — the existing `MailRule` model is unenforced CRUD only. This plan does not touch `MailRule`; it adds a separate, purpose-built `SenderRule` model that *is* actually evaluated.

Spam/Junk has no first-class backend concept — it's just whatever `Folder.path` Zimbra reports as `/Junk` (matched by string literal in `apps/web/components/layout/Sidebar.tsx:161-171` on the frontend). This plan looks it up the same way on the backend: `prisma.folder.findFirst({ where: { userId, path: '/Junk' } })`.

**Scope boundary (deliberate):** enforcement is wired into `getMessages` (folder listing) only — the dominant path through which new mail is first observed by a user. `getMessage` (single-message fetch) and `searchMessages` have their own separate upsert calls and are **not** wired up in this plan; a message opened directly by permalink or found via search before its folder is ever listed will not be auto-filed until this plan's follow-up extends the same call to those two paths. This is a scope decision, not an oversight — call it out if reviewing.

## Global Constraints

- Local Postgres only for `SenderRule` — no Zimbra SOAP call for storage (matches `MailRule` precedent).
- Follow the exact `@Req() req: AuthenticatedRequest` + `req.user.sub` pattern for the current user — there is no `@CurrentUser()` decorator in this codebase, don't introduce one.
- Migration command: `cd apps/api && npx prisma migrate dev --name <name>`.
- `apps/api` tests run with Jest (`*.spec.ts`, `pnpm --filter api test`); `apps/web` tests run with Vitest (`*.test.ts(x)`, `pnpm --filter web test`).

---

### Task 1: Prisma schema — `SenderRule` model

**Files:**
- Modify: `apps/api/prisma/schema.prisma`

**Interfaces:**
- Produces: `SenderRuleType` enum (`BLOCK` | `ALLOW`), `SenderRule` model (`id`, `userId`, `type`, `address`, `createdAt`) — later tasks read/write this model via `prisma.senderRule`.

- [ ] **Step 1: Add the enum and model**

Add near the `MailRule` model (after its closing `}`, still inside the `// ─── Mail ───` region) in `apps/api/prisma/schema.prisma`:

```prisma
enum SenderRuleType {
  BLOCK
  ALLOW
}

model SenderRule {
  id        String         @id @default(cuid())
  userId    String
  type      SenderRuleType
  // Exact address ("person@example.com") or a domain wildcard ("@example.com").
  address   String
  createdAt DateTime       @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, type, address])
  @@index([userId])
  @@map("sender_rules")
}
```

- [ ] **Step 2: Add the back-relation on `User`**

In the `User` model, alongside the existing `mailRules MailRule[]` line, add:

```prisma
  senderRules SenderRule[]
```

- [ ] **Step 3: Run the migration**

Run: `cd apps/api && npx prisma migrate dev --name add_sender_rules`
Expected: migration file created under `apps/api/prisma/migrations/`, Prisma Client regenerated, no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(mail): add SenderRule model for blocked/allowed senders"
```

---

### Task 2: Pure sender-matching function

**Files:**
- Create: `apps/api/src/mail/sender-rule-matcher.ts`
- Test: `apps/api/src/mail/sender-rule-matcher.spec.ts`

**Interfaces:**
- Produces: `matchSenderRule(fromEmail: string, rules: SenderRuleLike[]): 'BLOCK' | 'ALLOW' | null` and the `SenderRuleLike` type — consumed by Task 5's enforcement helper.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/mail/sender-rule-matcher.spec.ts
import { matchSenderRule, type SenderRuleLike } from './sender-rule-matcher';

describe('matchSenderRule', () => {
  it('returns null when no rules match', () => {
    expect(matchSenderRule('a@example.com', [])).toBeNull();
  });

  it('matches an exact blocked address', () => {
    const rules: SenderRuleLike[] = [{ type: 'BLOCK', address: 'spam@evil.com' }];
    expect(matchSenderRule('spam@evil.com', rules)).toBe('BLOCK');
  });

  it('matches a blocked domain wildcard', () => {
    const rules: SenderRuleLike[] = [{ type: 'BLOCK', address: '@evil.com' }];
    expect(matchSenderRule('anyone@evil.com', rules)).toBe('BLOCK');
  });

  it('is case-insensitive', () => {
    const rules: SenderRuleLike[] = [{ type: 'BLOCK', address: 'Spam@Evil.com' }];
    expect(matchSenderRule('spam@evil.com', rules)).toBe('BLOCK');
  });

  it('lets an exact ALLOW override a domain BLOCK', () => {
    const rules: SenderRuleLike[] = [
      { type: 'BLOCK', address: '@evil.com' },
      { type: 'ALLOW', address: 'trusted@evil.com' },
    ];
    expect(matchSenderRule('trusted@evil.com', rules)).toBe('ALLOW');
    expect(matchSenderRule('other@evil.com', rules)).toBe('BLOCK');
  });

  it('does not match unrelated domains', () => {
    const rules: SenderRuleLike[] = [{ type: 'BLOCK', address: '@evil.com' }];
    expect(matchSenderRule('person@good.com', rules)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx jest sender-rule-matcher -t "" --silent=false`
Expected: FAIL — `Cannot find module './sender-rule-matcher'`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/mail/sender-rule-matcher.ts
export type SenderRuleKind = 'BLOCK' | 'ALLOW';

export interface SenderRuleLike {
  type: SenderRuleKind;
  address: string;
}

/**
 * Resolves which rule applies to `fromEmail`, or null if none match.
 * ALLOW always wins over BLOCK when both match, so a broad domain block
 * can be paired with a narrower per-address allow.
 */
export function matchSenderRule(fromEmail: string, rules: SenderRuleLike[]): SenderRuleKind | null {
  const email = fromEmail.trim().toLowerCase();
  const atIndex = email.indexOf('@');
  const domain = atIndex >= 0 ? email.slice(atIndex) : '';

  const matches = (rule: SenderRuleLike): boolean => {
    const address = rule.address.trim().toLowerCase();
    return address.startsWith('@') ? domain === address : email === address;
  };

  if (rules.some((rule) => rule.type === 'ALLOW' && matches(rule))) return 'ALLOW';
  if (rules.some((rule) => rule.type === 'BLOCK' && matches(rule))) return 'BLOCK';
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx jest sender-rule-matcher`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mail/sender-rule-matcher.ts apps/api/src/mail/sender-rule-matcher.spec.ts
git commit -m "feat(mail): add pure sender-rule matcher with ALLOW-over-BLOCK precedence"
```

---

### Task 3: Backend CRUD — DTO + service methods

**Files:**
- Create: `apps/api/src/mail/dto/create-sender-rule.dto.ts`
- Modify: `apps/api/src/mail/mail.service.ts`
- Test: `apps/api/src/mail/mail.service.spec.ts`

**Interfaces:**
- Consumes: `SenderRuleLike`/`SenderRuleKind` from Task 2 (not required at this layer, but the DTO's `type` field must use the same two string literals).
- Produces: `MailService.getSenderRules(userId)`, `MailService.createSenderRule(userId, dto)`, `MailService.deleteSenderRule(userId, id)` — consumed by Task 4's controller.

- [ ] **Step 1: Write the DTO**

```ts
// apps/api/src/mail/dto/create-sender-rule.dto.ts
import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateSenderRuleDto {
  @IsIn(['BLOCK', 'ALLOW'])
  type!: 'BLOCK' | 'ALLOW';

  // Either a full address ("person@example.com") or a domain wildcard ("@example.com").
  @IsString()
  @MinLength(3)
  @MaxLength(320)
  @Matches(/^@?[^\s@]+@[^\s@]+\.[^\s@]+$|^@[^\s@]+\.[^\s@]+$/, {
    message: 'address must be an email address or a domain wildcard like "@example.com"',
  })
  address!: string;
}
```

- [ ] **Step 2: Write the failing service tests**

Create `apps/api/src/mail/mail.service.spec.ts` (first spec file for this module — establishes the pattern others can follow). Mock `PrismaService` and `ZimbraService` directly rather than a full testing module, since `MailService` has many other dependencies not relevant here:

```ts
// apps/api/src/mail/mail.service.spec.ts
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { MailService } from './mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { NotificationsService } from '../notifications/notifications.service';

function makeService() {
  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    senderRule: { findMany: jest.fn(), create: jest.fn(), findFirst: jest.fn(), delete: jest.fn() },
  } as unknown as PrismaService;
  const zimbra = {} as ZimbraService;
  const notifications = {} as NotificationsService;
  const service = new MailService(prisma, zimbra, notifications);
  return { service, prisma: prisma as any };
}

describe('MailService sender rules', () => {
  const user = { id: 'u1', authToken: 'tok', tokenExpiry: new Date(Date.now() + 60_000) };

  it('getSenderRules lists rules for the current user', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.senderRule.findMany.mockResolvedValue([{ id: 'r1', type: 'BLOCK', address: '@evil.com' }]);

    const result = await service.getSenderRules('u1');

    expect(prisma.senderRule.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'asc' },
    });
    expect(result).toEqual([{ id: 'r1', type: 'BLOCK', address: '@evil.com' }]);
  });

  it('getSenderRules rejects when the user has no Zimbra session', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ ...user, authToken: null });

    await expect(service.getSenderRules('u1')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('createSenderRule stores a lowercased, trimmed address', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.senderRule.create.mockResolvedValue({ id: 'r1', userId: 'u1', type: 'BLOCK', address: '@evil.com' });

    await service.createSenderRule('u1', { type: 'BLOCK', address: ' @Evil.com ' });

    expect(prisma.senderRule.create).toHaveBeenCalledWith({
      data: { userId: 'u1', type: 'BLOCK', address: '@evil.com' },
    });
  });

  it('deleteSenderRule throws NotFoundException for a rule the user does not own', async () => {
    const { service, prisma } = makeService();
    prisma.senderRule.findFirst.mockResolvedValue(null);

    await expect(service.deleteSenderRule('u1', 'missing-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deleteSenderRule removes an owned rule', async () => {
    const { service, prisma } = makeService();
    prisma.senderRule.findFirst.mockResolvedValue({ id: 'r1', userId: 'u1' });
    prisma.senderRule.delete.mockResolvedValue({});

    const result = await service.deleteSenderRule('u1', 'r1');

    expect(prisma.senderRule.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
    expect(result).toEqual({ success: true });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/api && npx jest mail.service -t "sender rules"`
Expected: FAIL — `getSenderRules is not a function` (method doesn't exist yet).

- [ ] **Step 4: Implement the service methods**

In `apps/api/src/mail/mail.service.ts`, add near the existing `// ─── Mail Rules ───` section (do not modify that section — this is a separate, enforced feature):

```ts
  // ─── Sender Rules (Blocked / Allowed) ───────────────────────────────────────

  async getSenderRules(userId: string) {
    await this.getUser(userId);
    return this.prisma.senderRule.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  async createSenderRule(userId: string, dto: { type: 'BLOCK' | 'ALLOW'; address: string }) {
    await this.getUser(userId);
    return this.prisma.senderRule.create({
      data: { userId, type: dto.type, address: dto.address.trim().toLowerCase() },
    });
  }

  async deleteSenderRule(userId: string, id: string) {
    const rule = await this.prisma.senderRule.findFirst({ where: { userId, id } });
    if (!rule) throw new NotFoundException('Sender rule not found');
    await this.prisma.senderRule.delete({ where: { id } });
    return { success: true };
  }
```

Import the DTO at the top of `mail.service.ts` if you want a typed parameter instead of the inline object type shown above — the existing `createRule`/`updateRule` methods use inline object types the same way, so either is consistent with this file's style.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx jest mail.service`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/mail/dto/create-sender-rule.dto.ts apps/api/src/mail/mail.service.ts apps/api/src/mail/mail.service.spec.ts
git commit -m "feat(mail): add sender-rule CRUD to MailService"
```

---

### Task 4: Backend controller endpoints

**Files:**
- Modify: `apps/api/src/mail/mail.controller.ts`

**Interfaces:**
- Consumes: `MailService.getSenderRules/createSenderRule/deleteSenderRule` from Task 3, `CreateSenderRuleDto` from Task 3.
- Produces: `GET /mail/sender-rules`, `POST /mail/sender-rules`, `DELETE /mail/sender-rules/:id` — consumed by Task 6's frontend API client.

- [ ] **Step 1: Add the import**

Near the other DTO imports in `apps/api/src/mail/mail.controller.ts`:

```ts
import { CreateSenderRuleDto } from './dto/create-sender-rule.dto';
```

- [ ] **Step 2: Add the endpoints**

Directly after the existing `// ── Rules ──` block (after `deleteRule`), add:

```ts
  // ── Sender Rules ─────────────────────────────────────────────────────────────

  @Get('sender-rules')
  getSenderRules(@Req() req: AuthenticatedRequest) {
    return this.mailService.getSenderRules(req.user.sub);
  }

  @Post('sender-rules')
  @HttpCode(HttpStatus.OK)
  createSenderRule(@Req() req: AuthenticatedRequest, @Body() dto: CreateSenderRuleDto) {
    return this.mailService.createSenderRule(req.user.sub, dto);
  }

  @Delete('sender-rules/:id')
  @HttpCode(HttpStatus.OK)
  deleteSenderRule(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.mailService.deleteSenderRule(req.user.sub, id);
  }
```

- [ ] **Step 3: Manually verify**

Run: `cd apps/api && pnpm dev` (or however the api dev server is normally started), then:
```bash
curl -X POST http://localhost:3001/api/mail/sender-rules \
  -H "Authorization: Bearer <your-dev-jwt>" -H "Content-Type: application/json" \
  -d '{"type":"BLOCK","address":"@spammer.test"}'
curl http://localhost:3001/api/mail/sender-rules -H "Authorization: Bearer <your-dev-jwt>"
```
Expected: POST returns the created rule with an `id`; GET returns an array containing it.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/mail/mail.controller.ts
git commit -m "feat(mail): expose sender-rule CRUD endpoints"
```

---

### Task 5: Enforcement — auto-file blocked senders to Spam

**Files:**
- Modify: `apps/api/src/mail/mail.service.ts`
- Test: `apps/api/src/mail/mail.service.spec.ts`

**Interfaces:**
- Consumes: `matchSenderRule` from Task 2, `SenderRule` rows from Task 1/3, `ZimbraService.moveMessage(host, authToken, zimbraMessageId, targetZimbraFolderId, csrfToken?)` (existing, `apps/api/src/zimbra/zimbra.service.ts:771`).
- Produces: `MailService.enforceSenderRules(userId, user, message)` — private, called from `getMessages`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/mail/mail.service.spec.ts`:

```ts
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { NotificationsService } from '../notifications/notifications.service';

describe('MailService.enforceSenderRules', () => {
  const user = { zimbraHost: 'mail.example.com', authToken: 'tok', csrfToken: 'csrf' };
  const message = { id: 'm1', zimbraId: 'z1', fromEmail: 'spam@evil.com', folderId: 'inbox-id' };

  function makeService() {
    const prisma = {
      senderRule: { findMany: jest.fn() },
      folder: { findFirst: jest.fn() },
      message: { update: jest.fn() },
    } as unknown as PrismaService;
    const zimbra = { moveMessage: jest.fn() } as unknown as ZimbraService;
    const notifications = {} as NotificationsService;
    const service = new MailService(prisma, zimbra, notifications);
    return { service: service as any, prisma: prisma as any, zimbra: zimbra as any };
  }

  it('does nothing when the user has no sender rules', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.senderRule.findMany.mockResolvedValue([]);

    await service.enforceSenderRules('u1', user, message);

    expect(zimbra.moveMessage).not.toHaveBeenCalled();
  });

  it('does nothing when an ALLOW rule matches', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.senderRule.findMany.mockResolvedValue([{ type: 'ALLOW', address: 'spam@evil.com' }]);

    await service.enforceSenderRules('u1', user, message);

    expect(zimbra.moveMessage).not.toHaveBeenCalled();
  });

  it('does nothing when the message is already in the Junk folder', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.senderRule.findMany.mockResolvedValue([{ type: 'BLOCK', address: '@evil.com' }]);
    prisma.folder.findFirst.mockResolvedValue({ id: 'inbox-id', path: '/Junk' });

    await service.enforceSenderRules('u1', user, message);

    expect(zimbra.moveMessage).not.toHaveBeenCalled();
  });

  it('moves a blocked sender\'s message to Junk', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.senderRule.findMany.mockResolvedValue([{ type: 'BLOCK', address: '@evil.com' }]);
    prisma.folder.findFirst
      .mockResolvedValueOnce({ id: 'inbox-id', path: '/Inbox' })   // current folder lookup
      .mockResolvedValueOnce({ id: 'junk-id', zimbraId: 'z-junk', path: '/Junk' }); // junk lookup

    await service.enforceSenderRules('u1', user, message);

    expect(zimbra.moveMessage).toHaveBeenCalledWith('mail.example.com', 'tok', 'z1', 'z-junk', 'csrf');
    expect(prisma.message.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { folderId: 'junk-id' } });
  });

  it('does nothing when the account has no Junk folder synced', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.senderRule.findMany.mockResolvedValue([{ type: 'BLOCK', address: '@evil.com' }]);
    prisma.folder.findFirst
      .mockResolvedValueOnce({ id: 'inbox-id', path: '/Inbox' })
      .mockResolvedValueOnce(null);

    await service.enforceSenderRules('u1', user, message);

    expect(zimbra.moveMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx jest mail.service -t "enforceSenderRules"`
Expected: FAIL — `service.enforceSenderRules is not a function`.

- [ ] **Step 3: Implement**

Add the import at the top of `apps/api/src/mail/mail.service.ts`:

```ts
import { matchSenderRule } from './sender-rule-matcher';
```

Add the method (private is fine — the tests above call it via the service instance directly, which works in TS/Jest regardless of the `private` keyword):

```ts
  private async enforceSenderRules(
    userId: string,
    user: { zimbraHost: string; authToken: string; csrfToken?: string | null },
    message: { id: string; zimbraId: string; fromEmail: string; folderId: string },
  ): Promise<void> {
    const rules = await this.prisma.senderRule.findMany({ where: { userId } });
    if (rules.length === 0) return;
    if (matchSenderRule(message.fromEmail, rules) !== 'BLOCK') return;

    const currentFolder = await this.prisma.folder.findFirst({ where: { id: message.folderId } });
    if (currentFolder?.path === '/Junk') return;

    const junkFolder = await this.prisma.folder.findFirst({ where: { userId, path: '/Junk' } });
    if (!junkFolder) return;

    await this.zimbra.moveMessage(
      user.zimbraHost,
      user.authToken,
      message.zimbraId,
      junkFolder.zimbraId,
      user.csrfToken ?? undefined,
    );
    await this.prisma.message.update({ where: { id: message.id }, data: { folderId: junkFolder.id } });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx jest mail.service`
Expected: PASS, all tests including the 5 from Task 3.

- [ ] **Step 5: Wire it into `getMessages`**

In `getMessages` (`apps/api/src/mail/mail.service.ts:104`), after the `Promise.allSettled` block that upserts messages, add a loop that runs enforcement for each successfully-upserted message:

```ts
    for (const result of results) {
      if (result.status === 'fulfilled') {
        // `user.authToken` is typed `string | null` on the Prisma model, but
        // `getUser()` above already throws UnauthorizedException when it's
        // falsy — the `!` mirrors the same assertion this method already
        // makes a few lines up when calling `this.zimbra.getMessages(...)`.
        await this.enforceSenderRules(
          userId,
          { zimbraHost: user.zimbraHost, authToken: user.authToken!, csrfToken: user.csrfToken },
          result.value,
        );
      }
    }
```

Place this immediately after the existing `const results = await Promise.allSettled(...)` block and before whatever `return` statement follows it in the current code.

- [ ] **Step 6: Manually verify end-to-end**

With the dev server running and a real (or test) Zimbra account: create a BLOCK rule for a domain you can send test mail from, send yourself a message from that domain, open the Inbox folder in the app (triggering `getMessages`), and confirm the message lands in Spam/Junk instead of Inbox.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/mail/mail.service.ts apps/api/src/mail/mail.service.spec.ts
git commit -m "feat(mail): auto-file blocked senders into Junk on folder sync"
```

---

### Task 6: Frontend API client

**Files:**
- Modify: `apps/web/lib/api.ts`

**Interfaces:**
- Consumes: `GET/POST/DELETE /mail/sender-rules(/:id)` from Task 4.
- Produces: `api.mail.senderRules.list()`, `.create(data)`, `.remove(id)` — consumed by Task 7's UI.

- [ ] **Step 1: Add the namespace**

In `apps/web/lib/api.ts`, directly after the existing `// ── Rules ──` block (after `deleteRule`), add:

```ts
    // ── Sender Rules ─────────────────────────────────────────────────────────
    senderRules: {
      list: () => {
        if (USE_MOCK) return delay<any[]>([]);
        return request<any[]>('/mail/sender-rules');
      },
      create: (data: { type: 'BLOCK' | 'ALLOW'; address: string }) => {
        if (USE_MOCK) return delay({ id: `sr-${Date.now()}`, ...data });
        return request<any>('/mail/sender-rules', { method: 'POST', body: JSON.stringify(data) });
      },
      remove: (id: string) => {
        if (USE_MOCK) return delay({ success: true });
        return request<any>(`/mail/sender-rules/${id}`, { method: 'DELETE' });
      },
    },
```

- [ ] **Step 2: Manually verify the shape compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/api.ts
git commit -m "feat(mail): add sender-rules API client namespace"
```

---

### Task 7: Frontend — Blocked & Allowed Senders settings section

**Files:**
- Modify: `apps/web/app/(app)/settings/page.tsx`
- Test: `apps/web/app/(app)/settings/blocked-senders.test.tsx` (colocated logic test — see Step 2)

**Interfaces:**
- Consumes: `api.mail.senderRules.list/create/remove` from Task 6.

- [ ] **Step 1: Add the nav item and icon import**

In the icon import block near the top of `apps/web/app/(app)/settings/page.tsx`, add `Ban` to the existing `lucide-react` import list:

```ts
import {
  User, Pen, Shield, Mail, Loader2, Plus, Trash2,
  Check, ChevronRight, RotateCcw, FileSignature,
  Palmtree, Settings2, Sparkles, AlertTriangle, Ban,
  Bold, Italic, Underline as UnderlineIcon, Image as ImageIcon,
} from 'lucide-react';
```

In the settings nav list (where `NavItem` entries for `vacation`, `preferences`, etc. are rendered), add a new item after Vacation Reply:

```tsx
        <NavItem icon={Ban} label="Blocked Senders" active={section === 'blocked-senders'} onClick={() => setSection('blocked-senders')} />
```

And in the section-dispatch block, add:

```tsx
              {section === 'blocked-senders' && <BlockedSendersSection />}
```

- [ ] **Step 2: Write a failing test for the address-validation helper**

This component needs one small piece of pure logic worth unit-testing on its own: rejecting empty/whitespace input before calling the API. Create `apps/web/app/(app)/settings/blocked-senders.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { isValidSenderAddress } from './blocked-senders-helpers';

describe('isValidSenderAddress', () => {
  it('accepts a plain email address', () => {
    expect(isValidSenderAddress('person@example.com')).toBe(true);
  });

  it('accepts a domain wildcard', () => {
    expect(isValidSenderAddress('@example.com')).toBe(true);
  });

  it('rejects empty or whitespace-only input', () => {
    expect(isValidSenderAddress('')).toBe(false);
    expect(isValidSenderAddress('   ')).toBe(false);
  });

  it('rejects input with no domain', () => {
    expect(isValidSenderAddress('notanaddress')).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run blocked-senders`
Expected: FAIL — `Cannot find module './blocked-senders-helpers'`.

- [ ] **Step 4: Implement the helper**

Create `apps/web/app/(app)/settings/blocked-senders-helpers.ts`:

```ts
export function isValidSenderAddress(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^@?[^\s@]+@[^\s@]+\.[^\s@]+$|^@[^\s@]+\.[^\s@]+$/.test(trimmed);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run blocked-senders`
Expected: PASS, 4 tests.

- [ ] **Step 6: Implement the `BlockedSendersSection` component**

Add to `apps/web/app/(app)/settings/page.tsx`, following the same `useState` + manual `handleSave`/toast pattern as `VacationSection` and `SecuritySection` elsewhere in this file:

```tsx
function BlockedSendersSection() {
  const [rules, setRules]   = useState<Array<{ id: string; type: 'BLOCK' | 'ALLOW'; address: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [blockInput, setBlockInput] = useState('');
  const [allowInput, setAllowInput] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.mail.senderRules.list();
      setRules(data);
    } catch (err: any) {
      toast.error('Failed to load sender rules', { description: err?.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const addRule = async (type: 'BLOCK' | 'ALLOW') => {
    const address = (type === 'BLOCK' ? blockInput : allowInput).trim();
    if (!isValidSenderAddress(address)) {
      toast.error('Enter an email address or a domain like "@example.com"');
      return;
    }
    setSaving(true);
    try {
      await api.mail.senderRules.create({ type, address });
      type === 'BLOCK' ? setBlockInput('') : setAllowInput('');
      await load();
      toast.success(type === 'BLOCK' ? 'Sender blocked' : 'Sender allowed');
    } catch (err: any) {
      toast.error('Failed to save', { description: err?.message });
    } finally {
      setSaving(false);
    }
  };

  const removeRule = async (id: string) => {
    try {
      await api.mail.senderRules.remove(id);
      setRules((prev) => prev.filter((r) => r.id !== id));
    } catch (err: any) {
      toast.error('Failed to remove', { description: err?.message });
    }
  };

  const blocked = rules.filter((r) => r.type === 'BLOCK');
  const allowed = rules.filter((r) => r.type === 'ALLOW');

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground/40" />
      </div>
    );
  }

  return (
    <div>
      <SectionHeader
        title="Blocked & Allowed Senders"
        description="Mail from blocked senders is moved to Spam automatically. Allowed senders are never auto-filed there."
      />

      <div className="max-w-sm space-y-6">
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider">Blocked</Label>
          <div className="flex gap-2">
            <Input
              value={blockInput}
              onChange={(e) => setBlockInput(e.target.value)}
              placeholder="person@example.com or @example.com"
              className="h-8 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/30"
            />
            <Button size="sm" onClick={() => addRule('BLOCK')} disabled={saving} className="h-8 text-xs gap-1.5">
              <Plus className="w-3.5 h-3.5" /> Block
            </Button>
          </div>
          {blocked.map((r) => (
            <div key={r.id} className="flex items-center justify-between text-sm py-1.5 px-2 rounded bg-muted/20">
              <span>{r.address}</span>
              <button onClick={() => removeRule(r.id)} className="text-muted-foreground/60 hover:text-destructive">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>

        <Separator />

        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider">Allowed</Label>
          <div className="flex gap-2">
            <Input
              value={allowInput}
              onChange={(e) => setAllowInput(e.target.value)}
              placeholder="person@example.com or @example.com"
              className="h-8 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/30"
            />
            <Button size="sm" onClick={() => addRule('ALLOW')} disabled={saving} className="h-8 text-xs gap-1.5">
              <Plus className="w-3.5 h-3.5" /> Allow
            </Button>
          </div>
          {allowed.map((r) => (
            <div key={r.id} className="flex items-center justify-between text-sm py-1.5 px-2 rounded bg-muted/20">
              <span>{r.address}</span>
              <button onClick={() => removeRule(r.id)} className="text-muted-foreground/60 hover:text-destructive">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

Add the import at the top of the file:

```ts
import { isValidSenderAddress } from './blocked-senders-helpers';
```

- [ ] **Step 7: Manually verify in the browser**

Run the web dev server, go to Settings → Blocked Senders, add a blocked address and an allowed address, confirm they appear in their respective lists and survive a page reload, then remove one and confirm it disappears. Also click through Settings → Vacation Reply and → Security to confirm the new nav item didn't break existing layout/spacing.

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/\(app\)/settings/page.tsx apps/web/app/\(app\)/settings/blocked-senders-helpers.ts apps/web/app/\(app\)/settings/blocked-senders.test.tsx
git commit -m "feat(mail): add Blocked & Allowed Senders settings UI"
```

---

## Follow-ups (explicitly out of scope for this plan)

- Wire `enforceSenderRules` into `getMessage` and `searchMessages` too, so a message never observed via folder listing still gets auto-filed.
- Bulk import of blocked domains (e.g. paste a list) — not requested, YAGNI for now.
