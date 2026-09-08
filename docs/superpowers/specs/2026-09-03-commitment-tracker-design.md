# Commitment & Follow-up Tracker — Design

**Date:** 2026-09-03
**Status:** Approved design, pending implementation plan
**Phase:** 3 of the inbox-intelligence roadmap (builds on phase 2's persisted cards; precedes search/chat)

## Purpose

A persistent ledger of what the user promised and what they are owed, projected automatically from the card store the phase-2 worker already maintains — each entry linked to its source message, resolved only by a human. Superhuman's Follow Up Faster is the market reference; ours runs entirely behind the firewall.

## Decisions (settled with the user)

- **Own ledger + promote-to-Task:** commitments live in their own table and panel; a one-click action creates a real `Task` (the Task model already carries `linkedMessageId`). Auto-extracted items never enter the task list uninvited.
- **Suggest, never auto-close:** when a newer card lands in the same conversation as an open commitment, the item gets a "reply received — review" hint. No model call judges fulfilment; no state changes without a human click.
- **30-day idle auto-archive:** open items with no activity (no new conversation mail, no user touch) for 30 days move to `archived` — out of the ledger view and counts, recoverable from an archive toggle, never silently deleted.
- **Projection runs inside the existing card worker** (chosen over a separate scheduler or read-time computation): card lands → commitments upsert in the same tick; no new jobs, no extra lag, and lifecycle state lives in real rows.

## Architecture

### 1. Data — `Commitment`

```prisma
model Commitment {
  id             String    @id @default(cuid())
  userId         String
  conversationId String?
  messageId      String    // source message (kept even after its card purges)
  type           String    // 'promised' | 'waiting'
  text           String
  dueHint        String?   // fuzzy, as stated in the mail ("by Friday")
  status         String    @default("open") // open | done | dismissed | archived | promoted
  suggestResolve Boolean   @default(false)
  hintMessageId  String?   // newest conversation message that triggered the hint
  taskId         String?   // set when promoted to a Task
  textHash       String    // sha256 of normalized text — dedupe key
  extractedAt    DateTime  @default(now())
  lastActivityAt DateTime  @default(now())
  resolvedAt     DateTime?

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, type, textHash])
  @@index([userId, status, lastActivityAt])
}
```

- `textHash` = sha256 of the lowercased, whitespace-collapsed text, so re-extraction of the same promise (same card re-processed, phrasing identical) never duplicates. Different phrasings of one real-world promise MAY produce two rows — accepted; dismiss handles it.
- No FK to `Message`/`MessageCard`: the ledger outlives the 90-day card purge by design. Opening a source message whose row was purged falls back to the normal message-open error path.
- `promoted` keeps `resolvedAt` set and `taskId` populated; the Task's lifecycle is then authoritative — the ledger does not sync back.

### 2. Worker projection (extends `CardWorkerService.processTick`)

After each successful, non-tombstone card upsert:

- **Extract:** sent-direction cards → one `promised` row per `commitmentsIMade[]` entry; received-direction cards with `waitingOn` → one `waiting` row. Rows created via upsert-on-unique (`userId+type+textHash`); an existing row (any status) is left untouched except `lastActivityAt` refresh when re-seen.
- **dueHint:** the card's first `deadlines[]` entry, if any (fuzzy text, stored verbatim after `neutralizeMarkers`).
- **Hint stamping:** when the processed card's `conversationId` matches open commitments of the same user (and the card's message is NEWER than the commitment's source), one `updateMany` sets `suggestResolve = true`, `hintMessageId`, `lastActivityAt`. This is the entire "resolution suggestion" mechanism — deterministic, zero model calls.
- **Text fields laundered** with `neutralizeMarkers` before storage (they are model output derived from attacker-controlled mail).
- **Aging:** in the existing hourly maintenance block: `status: 'open', lastActivityAt < now()-30d` → `status: 'archived'`. Constant `COMMITMENT_IDLE_ARCHIVE_DAYS = 30`.

### 3. API surface (mail controller, JWT-guarded, user-scoped)

- `GET /mail/commitments?status=open|archived` → `{ promised: CommitmentDto[], waiting: CommitmentDto[], openCount: number }`, newest-activity first, cap 200. `CommitmentDto` = the row minus `userId`/`textHash`, plus `counterparty` (source message's from-label when the message row still exists, else null). `openCount` always reflects `open` regardless of the status filter (drives the toolbar badge).
- `PATCH /mail/commitments/:id` body `{ status: 'done' | 'dismissed' | 'open' }` — human resolution/reopen; sets/clears `resolvedAt`, clears `suggestResolve` on any transition.
- `POST /mail/commitments/:id/promote` — creates a `Task` (title = commitment text, description carries the dueHint + a "from email" note, `linkedMessageId` = source id, `linkedSubject` looked up if the message row still exists), sets the commitment to `promoted` + `taskId`. Returns the created task id. Reuses `TasksService`'s creation path — no duplicate task logic.

### 4. Web UI

- **Toolbar button** (ClipboardCheck icon) next to "Brief me", visible when AI is enabled, with a small badge showing `openCount` (React Query, staleTime 60s).
- **Commitments slide-over** (briefing-drawer idiom, non-modal, no pill — it has no long-running state to preserve): sections *You promised* and *Waiting on*; each item shows text, counterparty + age, dueHint chip, and an amber "reply received — review" badge when `suggestResolve`. Row actions: open source message · ✓ done · dismiss · make a task. Header toggle switches to the archived view (read-only + reopen).
- **Briefing footer link:** "N open commitments →" opens this panel. The briefing's own composed sections are unchanged — the ledger is the persistent cross-window view, the brief stays the window-scoped synthesis; they deliberately do not share a pipeline.

### 5. Security & privacy

- Ledger rows are derived personal data in the same trust domain as cards; text laundered before storage; the panel renders text as plain text (no HTML).
- No new write surface on mail: promote writes a Task (existing feature), resolution writes only commitment rows.
- Cascade on user delete; commitments intentionally do NOT cascade from message deletion (ledger outlives the mail cache).

### 6. Testing

- **API (jest):** projection (sent→promised, received→waiting, dedupe via textHash, existing-row statuses untouched on re-seen), hint stamping (same conversation + newer message only; not on the commitment's own source card), 30-day archive boundary, endpoint scoping (no cross-user), PATCH transitions (+ suggestResolve cleared), promote (Task created with linkedMessageId; commitment → promoted; idempotence guard: promoting a non-open commitment 409s).
- **Web (vitest):** none required beyond typecheck/lint (standing no-component-test ruling); API client methods exercised through typecheck.
- **Manual E2E (post-deploy):** send yourself a promise from Sent ("I'll send X by Friday") → appears under You promised within a minute; reply in that thread from the counterparty side → hint badge appears; done/dismiss/promote flows; archive after simulated idle (verified via DB date tweak, not a 30-day wait).

## Out of scope (this phase)

Model-verified resolution judgments; syncing Task completion back to the ledger; commitments extracted from mail older than the card window (ledger starts from deployment); reminder notifications/emails; server-side triage label filtering (separate backlog item); phases 4a/4b.
