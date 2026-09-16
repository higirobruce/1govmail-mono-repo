# AI chat history — design

**Date:** 2026-09-16
**Status:** approved in chat; amended 2026-09-16 after review (90 days confirmed, tool-log expiry added)
**Branch:** ft-hyperscale

## 1. Why

A conversation with Ask 1Gov lives in React state and dies on refresh. Someone
who worked out a useful answer yesterday — which mails matter in a thread, what
a policy document actually says, what to do about a meeting — has no way back to
it. They ask again, which costs a GPU slot and their time, and they cannot check
what the assistant told them the first time.

This is the last of the six improvements Bruce asked for on 2026-09-13, and the
only one that was never designed, because it needed a retention decision first.

## 2. What already exists

| Piece | State |
|---|---|
| `AskPanel` holding turns in `useState<Turn[]>` | exists — `apps/web/components/ai/AskPanel.tsx` (866 lines) |
| A turn already carrying `content`, `sources`, and agent-mode `steps` / `proposals` | exists |
| Prior turns already sent upstream as `history`, trimmed by `historyLimitFor(scope)` | exists |
| `AiGeneration` persisting content **plus a `sources` JSON snapshot for chip re-render** | exists — the precedent this design copies |
| `AgentToolLog` retaining, per user and indefinitely, every tool call and its arguments | exists — **already unbounded today, see §8** |
| `useAskStore` with a consume-and-clear handoff (`AskOpenTarget`) | exists — `apps/web/stores/ask.store.ts` |
| `@Cron` worker pattern with `waitForCompletion: true` | exists — `DocEmbedWorkerService` |
| `sourceHref()`, the single definition of the `/mail?open=` and `/docs?open=` routes | exists — `apps/web/lib/ai/sourceNav.ts` |
| Any persistence of a conversation | **does not exist** |

So the turn shape, the sources-snapshot trick, the upstream history path, the
store handoff and the cron pattern are all already here. What is missing is a
table, a page, and a retention job.

## 3. Decisions taken

| Question | Decision |
|---|---|
| Whose record is it | **The user's own.** Each person sees only their own history. No administrator or auditor view — that would be a different product needing an access-control model, an audit log of who read whose history, and a signed-off retention schedule. |
| Deletion | **The user can delete** one conversation or all of it. |
| Expiry | **Automatic, 90 days**, matching the cache-eviction anchor already in the infra scale plan. Nothing is retained that the user did not choose to keep. |
| Which conversations | **All of them, with the scope recorded** — app-wide, thread-pinned and doc-pinned alike. A thread-scoped answer is the most common useful one; leaving it ephemeral would miss the point. |
| Replay | **Resumable.** Opening a saved conversation restores the turns and you can ask the next question. Citation chips stay clickable from the stored snapshot. |
| Stale agent proposals | **Inert on replay**, with a visible note. A proposal was composed against mail, a calendar and drafts that have all moved on; approving one blind is how someone sends the wrong thing. |
| Where it lives | **A page at `/ai/history`** with a nav entry, plus a clock icon in the Ask panel header. Bruce chose the page over an in-panel list, for search and for hunting through months. |
| Titles | **The first user question, trimmed** — not generated. §5.1. |
| Storage shape | **Two tables**, conversation and turns. §4. |
| Tool logs | **They expire too, and they die with their conversation.** Confirmed 2026-09-16. `agent_tool_logs` gains a nullable `conversationId` with `onDelete: Cascade`, plus the same 90-day age sweep as a backstop. §8. |

## 4. Storage shape, and why not the alternatives

Three shapes were considered.

**Chosen — two tables.** `AiConversation` holds identity (owner, scope, title,
last activity); `AiConversationTurn` holds one row per turn. Appending is one
small insert, search is an indexed `ILIKE`, and eviction deletes a conversation
and cascades.

**Rejected — one table with the transcript as a JSON blob.** Fewer moving parts
and atomic writes, but turns arrive *one at a time as they stream*, so every
append rewrites the whole blob. At twenty turns each carrying a sources
snapshot, that is a fat row rewritten on every question. Search would also have
to traverse JSON instead of using an index, and search is the reason the page
exists.

**Rejected — derive history from `agent_tool_logs`.** That table already has a
`turnId` and already retains per-user history, which makes it tempting. It
records which tools ran with what arguments and never the question or the
answer, so it cannot reconstruct a conversation.

### 4.1 Expected volume

A turn is roughly 2 KB of text plus about 3 KB of capped sources snapshot. At a
working estimate of thirty turns per person per week, 5,000 mailboxes and 90-day
retention, that is on the order of **10 GB steady-state**. `.155` is already at
78% disk, so the eviction job in §7 is load-bearing, not housekeeping.

## 5. Data model

```prisma
model AiConversation {
  id         String   @id @default(cuid())
  userId     String
  title      String   // the first user question, trimmed to 120 chars
  scopeKind  String   // 'app' | 'thread' | 'doc'
  scopeId    String?  // thread: seedMessageId · doc: docId · app: null
  scopeLabel String?  // thread subject / doc title, snapshotted at creation
  model      String   // which model answered — history outlives a model change
  createdAt  DateTime @default(now())
  lastTurnAt DateTime // what retention measures from

  turns    AiConversationTurn[]
  toolLogs AgentToolLog[]        // back-relation for the §8 cascade
  user     User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, lastTurnAt])
  @@map("ai_conversations")
}

model AiConversationTurn {
  id             String   @id @default(cuid())
  conversationId String
  userId         String   // denormalised — see below
  seq            Int      // 1-based position within the conversation
  role           String   // 'user' | 'assistant'
  content        String
  sources        Json     @default("[]") // AskSource[] — what keeps chips clickable
  steps          Json?    // agent mode
  proposals      Json?    // agent mode, replayed inert
  createdAt      DateTime @default(now())

  conversation AiConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@unique([conversationId, seq])
  @@index([userId])
  @@map("ai_conversation_turns")
}
```

Four choices that need defending:

- **`userId` is denormalised onto the turn.** Search is `where userId = ? and
  content ILIKE ?`. Without the copy, every search joins through the conversation
  merely to establish ownership. A conversation never changes hands, so the copy
  cannot drift. If search later slows, the escalation is a `pg_trgm` GIN index on
  `content`; this database already carries a hand-written HNSW index, so an
  extension is possible if it comes to that. Not needed for one user's 90 days.
- **No separate `[conversationId, seq]` index.** The compound unique already
  creates one; declaring both is a duplicate index that only costs writes.
- **`scopeLabel` is a snapshot.** A thread's subject or a document's title at the
  time of the conversation. It is what the history list renders, so the list
  stays readable when the thread is later purged or the document renamed.
- **`model` is recorded per conversation.** History outlives a model change, and
  an answer from a different model is worth being able to see as such.

### 5.1 Titles

The first user question, trimmed to 120 characters. Deliberately not generated: a
generated title costs a model call per conversation, and the infra anchors put
this at a 4-slot GPU pool for 5,000 mailboxes. Spending a slot on naming things
is the wrong trade, and a deterministic title is one a person can predict when
scanning a list.

Source `snippet`s are capped at 300 characters on persist. They are what makes a
chip's hover useful, so they stay — but uncapped they are most of the row.

## 6. Behaviour

### 6.1 When a conversation is written

A conversation row appears when the **first assistant turn completes** — not when
the panel opens, not on a keystroke. The user turn and its answer are written as
a pair at the moment the answer finishes, so a half-streamed response never lands
and the list never fills with empty shells. `lastTurnAt` bumps on every append.

"A turn pair" throughout this document means **two rows** — the user's question
and the assistant's answer — written together in one call with consecutive `seq`
values. `seq` counts rows, not exchanges, so a conversation of three questions
ends at `seq` 6.

Pressing Stop mid-answer discards the partial, and does not save the user turn on
its own. A transcript showing a truncated answer as though it were *the* answer is
worse than no record of that turn.

**"New conversation" changes meaning**: it saves the current conversation and
starts a fresh one rather than discarding it. Its tooltip currently reads
"clears this chat's history" and must change.

### 6.2 Resuming

| Scope | Where Resume goes |
|---|---|
| `app` | The Ask panel opens in place, on the history page itself. No navigation. |
| `thread` | `/mail?open=<scopeId>`, panel pinned to that thread, turns loaded. |
| `doc` | `/docs?open=<scopeId>`, panel scoped to that document. |

Both routes go through **`sourceHref()`**, never a hand-written URL. Two
hand-written `/docs?doc=` URLs that no page handled were the Critical finding of
the meeting-minutes review; there must be one definition of these routes.

The handoff is a `resumeId` field on `useAskStore`, set by the page and
consumed-and-cleared by `AskPanel` on mount — the pattern the store already uses
for `AskOpenTarget`, so this adds a field rather than a second mechanism.

**A thread scope is not stored in full, and does not need to be.** `AskThreadScope`
carries `conversationId`, `seedMessageId`, `subject`, `messageCount` and `locked`,
but only `seedMessageId` is persisted (as `scopeId`). Opening
`/mail?open=<seedMessageId>` lands on the thread, and the existing pin flow
reconstructs the rest from the thread it is looking at — which is also the only
way to get a `messageCount` that is true *now* rather than true last week. Do not
add four columns to store a scope that must be re-derived anyway.

Resuming feeds prior turns back as `history`, which is already what the panel
does for a live conversation. The same context budget and the same
`historyLimitFor(scope)` trimming apply; a long resumed conversation is trimmed
by the existing rule, not a new one.

### 6.3 The history page

`/ai/history`, with a nav entry, plus a clock icon in the Ask panel header beside
"New conversation" — the panel is where someone realises they want it.

One line per conversation: title, scope chip, turn count, relative time. Grouped
Today / Yesterday / Earlier this week / Older by `lastTurnAt`.

The turn count comes from Prisma's `_count: { select: { turns: true } }` on the
list query — **not** a denormalised counter column on the conversation. A counter
is one more thing to keep correct on every append and on the P2002 retry path,
to buy a subquery on a page of twenty-five rows. One search box
filters titles and turn content, via Prisma's `contains` with
`mode: 'insensitive'`, which compiles to `ILIKE` on Postgres — no raw SQL and no
hand-quoted camelCase identifiers.

Delete one, or delete everything. Both go through `useConfirmStore`, which takes
an `onConfirm` **callback** rather than returning a Promise.

### 6.4 Endpoints

In the existing `AiModule`. Every one scoped to the caller.

```
GET    /ai/conversations?q=&cursor=    list, newest by lastTurnAt, cursor-paginated
GET    /ai/conversations/:id           full transcript
POST   /ai/conversations               create with the first turn pair
POST   /ai/conversations/:id/turns     append a turn pair
DELETE /ai/conversations/:id           one
DELETE /ai/conversations               all
```

Another user's id returns **`NotFoundException`, never `Forbidden`**. A 403
confirms the row exists, which is itself a disclosure about someone else's
history.

## 7. Retention

A daily `@Cron` worker shaped like `DocEmbedWorkerService` (`waitForCompletion:
true`) deletes conversations past the horizon; turns cascade, and so do the tool
logs linked to them (§8). The same run also deletes tool logs whose own
`createdAt` passed the horizon, which is what bounds the rows that have no
conversation. The horizon is read from `AI_HISTORY_RETENTION_DAYS`, default 90,
so it is tunable without a deploy.

**90 days is confirmed** as the right horizon, not merely inherited from the
cache anchor (Bruce, 2026-09-16).

Two details carry the job:

- **Measured from `lastTurnAt`, not `createdAt`.** Otherwise a conversation
  someone is actively using disappears on its ninetieth day.
- **Deleted in batches with a per-tick cap.** A first run against a populated
  table would otherwise hold one long transaction on a pooled connection — the
  failure the notifications work hit, and the reason the meeting-minutes spec
  insists on small transactions.

It logs a count per run, as the embed worker does, so "is eviction running" is
answerable from the journal rather than from faith.

## 8. Tool logs expire with their conversation

`agent_tool_logs` records, per user, every tool the agent called and the
arguments it was called with. Until now it had no expiry, so a record of what
people asked the assistant to *do* has been accumulating unbounded since the
phase-4 agent work — predating this feature.

Bruce confirmed on 2026-09-16 that it should expire, and that a tool log should
die with the conversation it belongs to rather than merely ageing out.

**It is safe to expire.** The table is write-only: there is exactly one write site
(`agent.service.ts:503`, inside a `try/catch` whose comment reads "the audit log
must never break the stream") and nothing in the API or the web ever reads it
back — no `findMany`, no `count`, no `groupBy`. Its only use is being queried by
hand while diagnosing the agent. Nothing in the product breaks when a row goes.

### 8.1 Changes

- **`AgentToolLog.conversationId String?`** with a relation to `AiConversation`,
  `onDelete: Cascade`, and the matching `toolLogs AgentToolLog[]` back-relation on
  `AiConversation` (§5) — Prisma will not validate the schema without both sides.
  Deleting a conversation — by the user, or by the eviction worker — removes the
  record of what the agent did inside it.
- **An index on `conversationId`.** The cascade and the per-conversation delete
  both look rows up by it, and Prisma does not index a relation scalar by default.
- **The link is back-filled, not written inline.** An earlier draft of this spec
  said the write site would set `conversationId` from the conversation the turn
  belongs to. It cannot: tool logs are written server-side *while* the answer
  streams, and the conversation is created by the client only *after* the answer
  completes (§6.1). At tool-call time there is nothing to reference.

  The `turnId` already solves this. `agent.service.ts:71` mints one per agent turn
  and every tool log for that turn already carries it — it just never reaches the
  client. So:

  1. The agent emits one new frame at the start of a run, `emit('turn', { turnId })`,
     alongside the `tool_start` / `tool_result` / `proposal` / `clarify` frames it
     already sends.
  2. The client keeps that `turnId` and includes it when it persists the turn pair.
  3. The API back-fills the link:

  ```ts
  await tx.agentToolLog.updateMany({
    where: { turnId, userId, conversationId: null },
    data: { conversationId },
  });
  ```

  **The `userId` in that `where` is load-bearing, not decoration.** `turnId` is a
  UUID supplied by the client on this path, so without the owner check a caller
  could attach another user's tool logs to their own conversation and then read
  them by deleting it — or simply learn that a given turn existed. Scoping by
  `userId` makes an unowned `turnId` match zero rows. `conversationId: null` keeps
  a replayed request from re-pointing logs that are already linked.
- **Nullable on purpose.** Rows written before this change have no conversation,
  and an agent turn that produced no completed answer never creates one (§6.1),
  so its tool calls legitimately have none either.
- The same 90-day sweep in §7 also deletes logs whose `createdAt` passed the
  horizon. That is the backstop for the null rows, and it is what bounds the
  table for good.

### 8.2 Why not age-only

An age-only sweep would fix unbounded growth and nothing else. §3 promises that
nothing is retained which the user did not choose to keep, and age-only expiry
would contradict that sentence directly: a person could delete a conversation
and the log would still record that they had the agent send an email, for up to
ninety more days. The cascade is what makes the promise true.

## 9. Failure and edge behaviour

| Case | Behaviour |
|---|---|
| A history write fails | The answer is unaffected and a warning is logged. History is a convenience and must never block an answer. |
| A stored source points at a purged message | The chip degrades to plain text with a tooltip. `AiGeneration`'s snapshots already live with this. |
| Two tabs append to one conversation | `seq` is unique per conversation, so the loser raises P2002 — re-read `max(seq)` and retry once. The same shape as the meeting-minutes idempotency fix. |
| Resume target is gone (thread purged, doc deleted) | The panel opens app-wide with a line naming what the conversation was about and saying the source is unavailable. The turns stay readable; only dead chips degrade. |
| Retention removes a conversation open in another tab | Resume gets a 404 and reports that the conversation is no longer available, rather than erroring. |
| The account is deleted | Cascades. |
| A conversation with no completed answer | Never written (§6.1). |

## 10. Testing

- **Search is user-scoped** — another user's matching turn never surfaces. This
  is the security test, not a nicety.
- **Retention measures from `lastTurnAt`** — the test that catches `createdAt`
  being used by mistake. Plus: deletes past the horizon, spares an active
  conversation, honours the batch cap.
- **Resume routing** — each of the three scopes produces the right target, and a
  missing target degrades rather than throwing.
- **Sources round-trip** — chips are still clickable after a reload.
- **Append ordering** — `seq` increments, and the P2002 retry resolves rather
  than surfacing a 500.
- **Write failure does not break the answer** — the assertion that a rejected
  persist still leaves the turn rendered.
- **Deleting a conversation removes its tool logs** — the cascade in §8, asserted
  directly rather than inferred from the schema.
- **Tool logs with no conversation still age out** — the null-row backstop, which
  is the half a cascade test would silently miss.
- **Page behaviour** — grouping buckets and the delete-confirm wiring.

## 11. What this deliberately does not do

- **No administrator or auditor view.** §3. That is a different product.
- **No semantic search over history.** Titles and turn text, matched literally.
  Embedding every turn would add a GPU cost per turn on a 4-slot pool to solve a
  problem nobody has reported.
- **No sharing a conversation with a colleague.** It is a personal notebook. The
  existing docs-sharing machinery is there if a conversation needs to become a
  shared artefact.
- **No editing a past turn or branching a conversation.** Resume appends; it does
  not rewrite.
- **No export.** Copy out of the page works; a file export is a separate ask.

## 12. Known limits, for the release note

- History is personal and expires after 90 days of inactivity.
- Agent actions proposed in an earlier session cannot be approved from history;
  ask again to get a fresh proposal.
- A citation chip stops working if the mail or document it pointed at is gone.
- Search matches the words as typed; it is not semantic.
- Deleting a conversation also deletes the record of any action the agent took
  inside it.
