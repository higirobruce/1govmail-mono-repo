# Persistent Triage Labels — Design

**Date:** 2026-09-03
**Status:** Approved design, pending implementation plan
**Phase:** 2 of the inbox-intelligence roadmap (follows the shipped Executive Briefing; precedes commitment tracker and search/chat)

## Purpose

Classify incoming mail continuously on the server — using the same card extraction the Executive Briefing pioneered — and surface the result as actionable labels in the mail list: **Needs decision · Waiting on you · Deadline · FYI**. This is the keystone phase: it moves card extraction server-side once, persists it, and every later phase (commitment ledger, chat retrieval) reads the same store. The briefing gets near-instant as a side effect.

## Decisions (settled with the user)

- **Extraction model:** `qwen3-4b-fast:latest` via env `CARD_MODEL` (default), on the existing remote Ollama. The 30B stays for briefing reduce and future chat. The plan includes a one-time quality spot-check of 4B vs 30B card output before the worker ships.
- **Scope & retention:** backfill the last **14 days** of Inbox + Sent; purge cards whose message is older than **90 days**. Both constants, tunable.
- **Labels:** action vocabulary matching the briefing — Needs decision / Waiting on you / Deadline / FYI — shown as **filter chips with counts** above the message list and a **small colored badge** on classified rows. Unclassified rows show nothing.
- **Worker architecture:** stateless pull worker (approach A) — no queue table, no Redis. The "queue" is the query for classifiable messages missing a card.

## Architecture

### 1. Shared card module — `packages/shared`

The card logic moves out of `apps/web/lib/ai` into the existing `packages/shared` workspace package so web and API consume one implementation (a duplicated security-sensitive prompt would drift):

- `BriefingCard` type, card system prompt, `buildCardPrompt`, `parseCardJson` (with the truncation-repair JSON parser), `deriveLabel(card)`.
- The prompt-safety helpers it needs (`fenceUntrusted`, `neutralizeMarkers`, `detectInjectionAttempt`, `UNTRUSTED_CONTENT_RULE`) and the extraction pipeline (`extractEmailText` — its no-DOM fallback path serves Node) move with it, or are re-exported, whichever the plan finds cleaner — with the constraint that **web keeps thin re-exports** at the old paths so existing imports and tests do not churn.
- Pure TypeScript, no DOM-only APIs without fallback (Node 22 provides `crypto` webcrypto globally).

### 2. Data — `MessageCard`

New Prisma model:

```prisma
model MessageCard {
  id                 String   @id @default(cuid())
  messageId          String   @unique
  userId             String
  model              String
  gist               String
  asksOfMe           Json     @default("[]")
  deadlines          Json     @default("[]")
  commitmentsIMade   Json     @default("[]")
  waitingOn          String?
  importance         String   // 'high' | 'normal' | 'low'
  injectionSuspected Boolean  @default(false)
  failed             Boolean  @default(false) // tombstone: extraction gave up; invisible to reads
  extractedAt        DateTime @default(now())

  message Message @relation(fields: [messageId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, extractedAt])
}
```

`direction` is derivable from the message's folder; `from`/`subject`/`receivedAt` live on `Message` — not duplicated. One card per message; re-extraction (model change) overwrites (upsert on `messageId`).

### 3. Worker — `CardWorkerService`

- Cron every minute (`@nestjs/schedule`, `waitForCompletion: true`, same idiom as `MailScheduler`).
- **Selection query:** messages in each user's Inbox and Sent folders, `receivedAt >= now() - 14d`, no `MessageCard` row, user's `authToken` present and `tokenExpiry` in the future. Newest first, **per-user round-robin** (take up to K per user per tick) so one heavy mailbox cannot starve others. Batch ≤ `CARD_BATCH_PER_TICK` (default 8) per tick.
- **Body hydration:** through the existing `MailService.getMessage` path (which caches `bodyText`/`bodyHtml` on the row) using the stored Zimbra token. A Zimbra failure for one message skips it this tick — it stays in the selection query and is retried next tick.
- **Failed extraction:** a message whose model output stays unparseable after the retry gets a **tombstone card** (`failed: true`, empty fields) so the selection query stops re-picking it. Tombstones are invisible to all reads and are re-extracted only when `CARD_MODEL` changes.
- **Extraction:** shared `buildCardPrompt`/`parseCardJson`, `CARD_MODEL` env (default `qwen3-4b-fast:latest`), temperature 0, maxTokens 300, `response_format` JSON with the established retry-without fallback, calling Ollama directly (the service reuses `AiService.upstream`-style fetch or a thin internal client — plan decides; the JWT-guarded HTTP proxy is NOT in this path).
- **Purge:** same tick, delete cards (and tombstones) whose message `receivedAt < now() - 90d`. Constants `CARD_BACKFILL_DAYS = 14`, `CARD_RETENTION_DAYS = 90`.
- **Observability:** one summary log line per non-empty tick (`classified N, failed M, purged P, skipped-expired-token U users`).

### 4. API surface

- `GET /mail/cards?ids=<id,id,…>` — batch card lookup for visible list rows (user-scoped, max 100 ids, returns `{ cards: { [messageId]: { label, importance, injectionSuspected } } }` — the UI needs labels, not full cards).
- `GET /mail/cards/window?window=today|24h|week` — full cards for the briefing fast path (user-scoped, respects the same folder scope, capped at the briefing cap).
- Both JWT-guarded; both read-only.

### 5. Web UI

- `deriveLabel(card)` (shared): `needsDecision` when `asksOfMe` non-empty; else `waitingOnYou` when `waitingOn` set; else `deadline` when `deadlines` non-empty; else `fyi`. (Priority order fixed; a card can carry several signals — the label is the strongest.)
- Mail list: filter chips **Needs decision · Waiting on you · Deadline** with live counts above the list (FYI is the unfiltered rest — no chip); clicking filters the current folder view client-side over loaded pages. Row badge: small colored dot + short label on classified rows, ⚠ retained for `injectionSuspected`.
- Cards fetched in batch for the visible page of messages (one `GET /mail/cards` per page load), cached in the existing React Query layer.
- Labels appear only for Inbox/Sent messages inside the 14-day window — the UI states nothing about older mail (no "unclassified" noise).

### 6. Briefing fast path

`generateBriefing` gains a first step: fetch stored cards for the window from `GET /mail/cards/window`. Messages with a stored card skip hydrate+map entirely; only stragglers (not yet reached by the worker) run the existing client-side extraction with the user's selected model. Reduce is unchanged. Coverage line unchanged (cards are cards, wherever computed).

## Security & privacy

- Same fencing/scrub/detection in the worker via the shared module; the worker only annotates — it never sends, moves, or deletes mail.
- Cards are derived personal data in the same Postgres trust domain as the mail cache itself; the 90-day purge bounds the footprint. Deleting a message cascades its card.
- The worker uses stored Zimbra tokens exactly as scheduled-send already does; expired tokens are skipped silently, never refreshed by the worker.
- `injectionSuspected` persists so the list view can badge manipulative mail even before it is opened.

## Testing

- **Shared module (vitest):** existing card tests move with the code; add `deriveLabel` priority-order tests.
- **API (jest):** selection query (window bounds, missing-card-only, expired-token exclusion, round-robin fairness), tombstone behavior (failed extraction stops re-selection; invisible to reads), upsert idempotence, purge boundary, `GET /mail/cards` scoping (no cross-user reads), batch cap.
- **Web (vitest):** label chip filtering, badge rendering states, briefing fast path (stored cards skip map; stragglers still mapped; counts correct).
- **Manual E2E (post-deploy):** worker drains a fresh mailbox; chips filter; badge on an injection-bearing mail; briefing runs in seconds on second use; expired-token user is skipped without errors.

## Out of scope (this phase)

Zimbra tag write-back; user-defined custom labels; commitment lifecycle (phase 3); embeddings/search/chat (phase 4); classification of folders beyond Inbox/Sent; any write action by the worker; admin dashboards for worker health (log line only).
