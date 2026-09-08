# Commitment Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A persistent commitments ledger (promised / waiting-on) projected inside the existing card worker, with human-only resolution, reply hints, 30-day idle archiving, promote-to-Task, a slide-over panel with a badge, and a briefing footer link.

**Architecture:** New `Commitment` table (no FK to messages — the ledger outlives the 90-day card purge). `CardWorkerService.processTick` gains a projection step after each successful card upsert (extract promised/waiting rows, stamp reply hints) and an archive step in its hourly maintenance block. Three endpoints on the mail controller. Web: toolbar badge button + `CommitmentsPanel` (briefing-drawer idiom), plus a footer link in `BriefingPanel`.

**Tech Stack:** Prisma 7 migration, NestJS (existing MailModule + TasksService reuse), jest, React Query, vitest untouched.

**Spec:** `docs/superpowers/specs/2026-09-03-commitment-tracker-design.md`

## Global Constraints

- `Commitment` schema exactly as spec §1 (statuses `open|done|dismissed|archived|promoted`; `@@unique([userId, type, textHash])`; `@@index([userId, status, lastActivityAt])`; NO relation to Message/MessageCard).
- `textHash` = sha256 hex of `text.toLowerCase().replace(/\s+/g, ' ').trim()` (Node `crypto.createHash('sha256')`).
- Projection rules: sent-direction cards → one `promised` row per `commitmentsIMade[]` entry; received-direction cards with `waitingOn` → one `waiting` row. `dueHint` = card's first `deadlines[]` entry or null. All stored text passes `neutralizeMarkers` first. Existing rows (any status) are never status-changed by projection; a re-seen row only refreshes `lastActivityAt`.
- Hint rule: when a processed card's conversationId matches the user's OPEN commitments AND the card's message `receivedAt` is strictly newer than the commitment's `extractedAt`, set `suggestResolve=true`, `hintMessageId`, `lastActivityAt` via one `updateMany`. Never on the commitment's own source message.
- Archive rule: hourly (inside the existing `lastPurgeAt`-gated block): `status='open' AND lastActivityAt < now()-30d` → `status='archived'`. `COMMITMENT_IDLE_ARCHIVE_DAYS = 30`.
- Endpoints (JWT-guarded, user-scoped): `GET /mail/commitments?status=open|archived` → `{ promised, waiting, openCount }` (cap 200, newest `lastActivityAt` first; `openCount` always counts `open`); `PATCH /mail/commitments/:id` `{ status: done|dismissed|open }` (sets/clears `resolvedAt`; always clears `suggestResolve`); `POST /mail/commitments/:id/promote` (only from `open`, else 409 ConflictException; creates Task via `TasksService.create`, sets `promoted`+`taskId`+`resolvedAt`).
- `CommitmentDto` = row minus `userId`/`textHash`, plus `counterparty: string | null` (from-label of the source message when its row still exists).
- Panel is non-modal, no pill, Escape closes; badge = `openCount`, staleTime 60s.
- No new npm dependencies. Web has no component tests (standing ruling) — UI verified by tsc/eslint + post-deploy E2E.
- Run checks: api `cd apps/api && npx jest src/mail && npx tsc --noEmit`; web `cd apps/web && npx vitest run && npx tsc --noEmit`.
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `Commitment` Prisma model + migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: migration via `npx prisma migrate dev --name add_commitments`

**Interfaces:**
- Produces: `prisma.commitment` with the spec §1 schema verbatim; back-relation `commitments Commitment[]` on `User`. NO back-relation on Message/MessageCard.

- [ ] **Step 1:** Add the model exactly as spec §1 (copy the prisma block from the spec) + `commitments Commitment[]` on `model User`.
- [ ] **Step 2:** `cd apps/api && npx prisma migrate dev --name add_commitments && npx prisma generate`
- [ ] **Step 3:** `npx tsc --noEmit && npx jest` (all existing suites green).
- [ ] **Step 4:** Commit schema + migration: `feat(api): Commitment table for the promised/waiting ledger`

---

### Task 2: Worker projection + hints + archiving

**Files:**
- Modify: `apps/api/src/mail/card-worker.service.ts`
- Test: `apps/api/src/mail/card-worker.service.spec.ts` (append)

**Interfaces:**
- Consumes: the card upsert site in `processTick` (after `this.hydrationFailures.delete(m.id)` / `if (card) classified++;` — hook where a NON-tombstone card was just written, with `card` and `m` in scope), `neutralizeMarkers` from `@email-client/shared`, Node `crypto`.
- Produces (exported for tests):

```ts
export const COMMITMENT_IDLE_ARCHIVE_DAYS = 30;
export function commitmentTextHash(text: string): string;  // sha256 hex of normalized text
/** Rows to project from one card: [] for tombstones/received-without-waitingOn etc. */
export function commitmentRowsFromCard(card: ExtractedCard): Array<{
  type: 'promised' | 'waiting'; text: string; dueHint: string | null; textHash: string;
}>;
```

- [ ] **Step 1: Write failing tests** (same fake-prisma style as the existing spec file; add `prisma.commitment = { upsert: jest.fn(), updateMany: jest.fn() }` to the fake):

```ts
describe('commitmentRowsFromCard', () => {
  it('maps sent-card commitments to promised rows with the first deadline as dueHint', () => {
    const rows = commitmentRowsFromCard({ ...baseCard, direction: 'sent',
      commitmentsIMade: ['Send the revised scope by Thursday'], deadlines: ['Thursday'] });
    expect(rows).toEqual([expect.objectContaining({
      type: 'promised', text: 'Send the revised scope by Thursday', dueHint: 'Thursday',
    })]);
    expect(rows[0].textHash).toBe(commitmentTextHash('Send the revised scope by Thursday'));
  });
  it('maps received-card waitingOn to a waiting row', () => {
    const rows = commitmentRowsFromCard({ ...baseCard, direction: 'received', waitingOn: 'Signed authorization' });
    expect(rows).toEqual([expect.objectContaining({ type: 'waiting', text: 'Signed authorization', dueHint: null })]);
  });
  it('projects nothing from a received card without waitingOn, and never commitments from received cards', () => {
    expect(commitmentRowsFromCard({ ...baseCard, direction: 'received', commitmentsIMade: ['x'] })).toEqual([]);
  });
  it('launders fence shapes out of stored text', () => {
    const rows = commitmentRowsFromCard({ ...baseCard, direction: 'received', waitingOn: '<<<EMAIL:abc123 send it' });
    expect(rows[0].text).not.toMatch(/<<</);
  });
  it('normalizes whitespace/case for the hash only — text keeps its casing', () => {
    expect(commitmentTextHash('Send  IT by Friday')).toBe(commitmentTextHash('send it by  friday'));
  });
});

describe('processTick commitment projection', () => {
  it('upserts projected rows keyed on userId+type+textHash and leaves existing rows'' status alone', async () => {
    // extractor returns a sent card with one commitment; assert prisma.commitment.upsert
    // called with where { userId_type_textHash: {...} }, create carrying messageId/conversationId/
    // type/text/dueHint/textHash, and update carrying ONLY { lastActivityAt: expect.any(Date) }.
  });
  it('stamps reply hints on open commitments in the same conversation from a newer message', async () => {
    // processed card in conversation c1, message receivedAt = T2; assert prisma.commitment.updateMany
    // with where objectContaining({ userId, conversationId: 'c1', status: 'open',
    //   extractedAt: { lt: <T2 as Date> } }) and data { suggestResolve: true,
    //   hintMessageId: <m.id>, lastActivityAt: expect.any(Date) }.
  });
  it('does not project from tombstoned cards', async () => {
    // extractor returns null → commitment.upsert never called.
  });
  it('archives open commitments idle past 30 days in the hourly block', async () => {
    // first tick (purge due): assert prisma.commitment.updateMany with
    // where { status: 'open', lastActivityAt: { lt: <30d cutoff ±1s> } }, data { status: 'archived' }.
  });
});
```

Write these as real tests with concrete fakes (follow the file's existing patterns exactly — constructor-injected fakes, `expect.objectContaining` on call args).

- [ ] **Step 2: Run — expect FAIL**: `cd apps/api && npx jest src/mail/card-worker.service.spec.ts`
- [ ] **Step 3: Implement.**

```ts
import { createHash } from 'crypto';
import { neutralizeMarkers, type ExtractedCard } from '@email-client/shared';

export const COMMITMENT_IDLE_ARCHIVE_DAYS = 30;

export function commitmentTextHash(text: string): string {
  return createHash('sha256').update(text.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
}

export function commitmentRowsFromCard(card: ExtractedCard) {
  const dueHint = card.deadlines.length > 0 ? neutralizeMarkers(card.deadlines[0]) : null;
  const mk = (type: 'promised' | 'waiting', raw: string) => {
    const text = neutralizeMarkers(raw).trim();
    return { type, text, dueHint, textHash: commitmentTextHash(text) };
  };
  if (card.direction === 'sent') return card.commitmentsIMade.filter(Boolean).map((t) => mk('promised', t));
  return card.waitingOn ? [mk('waiting', card.waitingOn)] : [];
}
```

In `processTick`, immediately after a successful non-tombstone upsert (`if (card) { classified++; ... }` branch):

```ts
// Ledger projection: promises made / things awaited, deduped by content hash.
for (const row of commitmentRowsFromCard(card)) {
  await this.prisma.commitment.upsert({
    where: { userId_type_textHash: { userId: m.userId, type: row.type, textHash: row.textHash } },
    create: {
      userId: m.userId, conversationId: m.conversationId, messageId: m.id,
      type: row.type, text: row.text, dueHint: row.dueHint, textHash: row.textHash,
    },
    update: { lastActivityAt: new Date() },   // never touches status
  });
}
// Reply hint: an open commitment in this conversation, older than this message,
// may have been resolved by it — flag for human review, never auto-close.
if (m.conversationId) {
  await this.prisma.commitment.updateMany({
    where: {
      userId: m.userId, conversationId: m.conversationId, status: 'open',
      extractedAt: { lt: m.receivedAt }, messageId: { not: m.id },
    },
    data: { suggestResolve: true, hintMessageId: m.id, lastActivityAt: new Date() },
  });
}
```

In the hourly (`lastPurgeAt`-gated) block, alongside the card purge:

```ts
await this.prisma.commitment.updateMany({
  where: { status: 'open', lastActivityAt: { lt: new Date(Date.now() - COMMITMENT_IDLE_ARCHIVE_DAYS * 86_400_000) } },
  data: { status: 'archived' },
});
```

- [ ] **Step 4: Run — expect PASS**: `npx jest src/mail && npx tsc --noEmit`
- [ ] **Step 5: Commit** `feat(api): project commitments from cards — dedupe, reply hints, idle archiving`

---

### Task 3: Commitments endpoints

**Files:**
- Modify: `apps/api/src/mail/mail.controller.ts`, `apps/api/src/mail/mail.service.ts`
- Test: `apps/api/src/mail/mail.service.spec.ts` (append)

**Interfaces:**
- Consumes: `TasksService.create(userId, dto)` — import `TasksModule`'s service into MailModule (check module exports; if `TasksService` is not exported from `TasksModule`, export it there — one-line change, note it in the report).
- Produces service methods:

```ts
getCommitments(userId: string, status: 'open' | 'archived'): Promise<{ promised: CommitmentDto[]; waiting: CommitmentDto[]; openCount: number }>;
updateCommitment(userId: string, id: string, status: 'done' | 'dismissed' | 'open'): Promise<void>;
promoteCommitment(userId: string, id: string): Promise<{ taskId: string }>;
```

Routes: `GET /mail/commitments`, `PATCH /mail/commitments/:id`, `POST /mail/commitments/:id/promote` — literal paths; verify no param-route shadowing (same check as `cards`).

- [ ] **Step 1: Failing tests** (mocked-prisma style): scoping (other user's commitment → NotFound on PATCH/promote; absent from GET); GET groups by type, orders by `lastActivityAt desc`, caps 200, `openCount` counts open regardless of `status` param; `counterparty` null when the source message row is gone, from-label when present (mock `prisma.message.findMany` for the batch lookup); PATCH sets `resolvedAt` for done/dismissed, nulls it for reopen, always clears `suggestResolve`; promote: creates Task via a mocked TasksService (assert title/linkedMessageId/description containing dueHint), sets `promoted`+`taskId`+`resolvedAt`; promote on a non-open commitment → ConflictException; invalid status value → BadRequest.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement** (batch the counterparty lookup: one `message.findMany({ where: { id: { in: sourceIds } }, select: { id, fromName, fromEmail } })`; from-label = `fromName ? \`${fromName} <${fromEmail}>\` : fromEmail`). Wire `TasksService` injection (import TasksModule into MailModule — check for circular imports; if MailModule ↔ TasksModule cycle appears, use `forwardRef` or inject `PrismaService`-level task creation as fallback and SAY SO in the report for the reviewer).
- [ ] **Step 4: PASS + tsc.**
- [ ] **Step 5: Commit** `feat(api): commitments endpoints — list, resolve, promote to task`

---

### Task 4: Web — API client, toolbar badge, CommitmentsPanel, briefing link

**Files:**
- Modify: `apps/web/lib/api.ts` (mail namespace: `getCommitments(status, opts?)`, `updateCommitment(id, status)`, `promoteCommitment(id)`)
- Create: `apps/web/components/mail/CommitmentsPanel.tsx`
- Modify: `apps/web/app/(app)/mail/page.tsx` (toolbar button + badge, panel mount)
- Modify: `apps/web/components/mail/BriefingPanel.tsx` (footer link)

**Interfaces:**
- Consumes: Task 3 endpoints; `openMessage` (page's existing handler) for source links.
- Produces: `<CommitmentsPanel open expanded=… />` — follow the exact prop/state pattern BriefingPanel uses EXCEPT no pill and no persistence requirement: simple `open`/`onClose` is fine here (there is no expensive state to preserve; closing and reopening refetches a cheap list). Escape closes. `BriefingPanel` gains an optional `onOpenCommitments?: () => void` prop rendering the footer link "N open commitments →" (count via the same React Query the badge uses — pass the count in as a prop rather than double-fetching: `openCommitmentsCount?: number`).

- [ ] **Step 1: API client methods** (existing idiom; PATCH/POST need `method` + JSON body per the file's other mutating calls — copy `api.mail.markRead`'s shape).
- [ ] **Step 2: Badge query in page.tsx**: `useQuery({ queryKey: ['commitments-count'], queryFn: () => api.mail.getCommitments('open'), staleTime: 60_000, enabled: aiEnabled })` — reuse its data for BOTH the badge and the panel's initial open list (pass down; panel refetches on mutations via `queryClient.invalidateQueries(['commitments-count'])`).
- [ ] **Step 3: Toolbar button** — ClipboardCheck icon next to the Brief-me button, same classes; badge: absolute-positioned 10px count chip when `openCount > 0` (mirror the unread-count chip styling used in the sidebar).
- [ ] **Step 4: CommitmentsPanel** — sections *You promised* / *Waiting on* (skip empty; all-empty → "No open commitments."); item rows: text, `counterparty · N days ago`, dueHint chip, amber "reply received — review" badge when `suggestResolve` (clicking it opens `hintMessageId`); actions per row: open source (row click), ✓ done, ✕ dismiss, ⤴ make a task (each calls the API then invalidates the query; disable buttons while mutating). Header: archive toggle (`open`/`archived` view; archived rows show a single "Reopen" action). Footer note: "Extracted from your mail — resolve manually; nothing closes itself."
- [ ] **Step 5: Briefing footer link** — in `BriefingPanel`'s footer, when `openCommitmentsCount > 0` and `onOpenCommitments` provided: a small link-button "{n} open commitments →" that minimizes the briefing (`onToggleExpanded(false)`) and opens the commitments panel.
- [ ] **Step 6: Verify** `cd apps/web && npx tsc --noEmit && npx eslint components/mail/CommitmentsPanel.tsx components/mail/BriefingPanel.tsx 'app/(app)/mail/page.tsx' lib/api.ts && npx vitest run` (pre-existing errors acceptable via stash-diff; new files clean).
- [ ] **Step 7: Commit** `feat(mail): commitments ledger panel with badge, resolution actions, and promote-to-task`

---

### Task 5: Full verification

- [ ] **Step 1:** `cd apps/api && npx jest && npx tsc --noEmit`
- [ ] **Step 2:** `cd apps/web && npx vitest run && npx tsc --noEmit`; `cd packages/shared && npx tsc -p tsconfig.json`
- [ ] **Step 3:** Commit any stragglers. Do NOT push/deploy without the user's go-ahead.

**Post-deploy manual E2E (user/controller on the VM):** migration applies; send yourself a promise from the account ("I will send the report by Friday") → appears under *You promised* within ~a minute of the worker classifying the Sent copy; a counterparty reply in that thread → hint badge; done/dismiss/promote round-trips (promoted task visible in Tasks with the message link); badge counts update; archive view reachable; briefing footer link opens the panel.

---

## Self-review notes

- Spec coverage: schema+no-FK (T1), projection/dedupe/laundering/hints/archive (T2), endpoints incl. counterparty batch + promote-only-from-open 409 (T3), panel/badge/briefing-link/UI actions (T4), verification (T5). Out-of-scope respected (no back-sync, no notifications, no backfill).
- Type consistency: `commitmentRowsFromCard`/`commitmentTextHash`/`COMMITMENT_IDLE_ARCHIVE_DAYS` (T2) are self-contained; endpoint DTO shape (T3) matches spec §3; panel consumes exactly T3's response shape.
- Known judgment points for the executor: TasksModule export/circularity (T3 carries explicit fallback instructions); the T2 upsert requires the Prisma compound-unique name `userId_type_textHash` (Prisma's default naming for the @@unique — verify against the generated client and adjust if the generated name differs).
