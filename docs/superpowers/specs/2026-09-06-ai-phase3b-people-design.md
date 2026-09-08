# AI Phase 3b — People: Relationship Dossier + Meeting Prep Pack

**Date:** 2026-09-06 · **Status:** design approved in chat by Bruce (sections 1–4); spec pending review
**Scope:** the people layer of phase 3: a per-counterparty relationship dossier and an on-demand meeting prep pack, both shipped in one run as planned in the 3a spec's out-of-scope list.
**Surfaces:** apps/api (one migration: `messages` fromEmail index + `ai_generations` cache table; new PeopleModule; two streaming endpoints in the chat module), apps/web (people store + docked dossier panel, sender/attendee entry points, Prep view in the calendar event detail panel, streaming client + api namespaces).

User decisions locked in chat:
1. Both features ship in **one 3b run** (one spec, one plan) — they share the counterparty-query layer.
2. Dossier primary entry is **sender click → docked panel** (attendee rows in the event panel are the secondary entry).
3. Prep pack is **on-demand on the event detail panel**, cached per event — no pre-generation worker.
4. Dossier facts load **instantly and deterministically**; the AI narrative streams **on demand** ("Summarize relationship") and is cached until newer mail from that person arrives.
5. Generated narratives/packs cache **server-side** in a small DB table (survives reloads and devices), not client storage.

## Standing invariants (carried verbatim from 3a)

- The RAG boundary stays server-side: retrieval, ACL, prompt assembly, and upstream streaming happen in the API. Full chunk text never reaches the browser — sources ship as ≤160-char snippets.
- Every source is fenced (`fenceUntrusted`) with per-type labels (EMAIL / DOCUMENT / EVENT); headers and person-supplied strings (subjects, display names, event titles) pass through `neutralizeMarkers`; prompts keep the four mandates (ground-or-say-so, cite aliases in square brackets, alias-only references, excerpts are data not instructions); `splitByCitations`'s whitelist means the model cannot mint a reference the server didn't vouch for.
- `detectInjectionAttempt` + card-flag OR runs on every context piece; `injectionSuspected` drives the existing amber banner.
- Leg failures degrade, never error: context legs are `allSettled` with per-leg `degraded` flags; zero usable context short-circuits to a no-context reply without a model call.
- Access control truths: doc read access = owner OR `DocumentInvite` matched by the user's email, evaluated at query time. Anonymous share-token paths carry no user identity → **no AI on them**. Calendar events are owner-scoped by `userId`.

## Identity model

A **person** is a lowercased email address. Display name resolves in order: contacts entry → most recent `fromName` seen → the address itself. No person table, no merging of aliases in v1 (two addresses = two dossiers). The user's own address is never a dossier target (400).

## Data layer

One Prisma migration (`add_people_phase3b`):

1. **`@@index([userId, fromEmail, receivedAt])` on `messages`** — powers "mail from this person" for dossier facts, dossier narrative context, and per-attendee prep legs. Sent-to-them mail is matched with a JSONB scan over `toRecipients` (23 users / small corpus — no index until it hurts).
2. **`ai_generations`** — shared cache for both features:

```prisma
model AiGeneration {
  id           String   @id @default(cuid())
  userId       String
  kind         String   // 'dossier' | 'meeting_prep'
  targetKey    String   // dossier: lowercased email · meeting_prep: eventId
  content      String   // the generated markdown/text
  sources      Json     @default("[]") // PublicChatSource[] snapshot for chip re-render
  model        String
  sourceAnchor DateTime // newest source timestamp considered at generation time
  generatedAt  DateTime @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, kind, targetKey])
  @@index([userId, kind])
  @@map("ai_generations")
}
```

Staleness is computed at read time, never stored: a dossier row is stale when any message to/from `targetKey` has `receivedAt > sourceAnchor`; a prep row is stale when `event.updatedAt > sourceAnchor` OR any message from an attendee has `receivedAt > sourceAnchor`. Stale rows are still served (with `stale: true`) — regeneration is always user-initiated.

The HNSW caveat does not apply here (no vector columns), but the migration is still hand-checked against Prisma's spurious drift offer to drop `message_embeddings_embedding_hnsw_idx` / `document_embeddings` HNSW — decline as always.

## API — PeopleModule (deterministic facts)

New `apps/api/src/people/` (module, controller, service, DTOs). JWT-guarded.

**`GET /people/dossier?email=`** → instant facts, all scoped to the requesting `userId`:

- `profile`: display name (contacts → latest `fromName` → address), email, firstSeenAt, lastSeenAt, message counts (from them / to them, last 90 days).
- `recentConversations`: latest 8 conversations involving the person (both directions), each `{conversationId, messageId, subject, snippet, direction, at}` — subject/snippet raw for UI display (they render as text, not prompts).
- `commitments`: open Commitments whose source message involves the person — join `Commitment.messageId → messages`, match `fromEmail = person` (their mail) OR person ∈ `toRecipients` (mail I sent). Split `promised` (I owe them) / `waiting` (they owe me), each `{id, type, text, dueHint, messageId, lastActivityAt}`.
- `sharedEvents`: CalendarEvents where `organizer = email` OR attendees JSONB contains the email — next 5 upcoming + last 3 past, `{id, title, startAt, endAt}`.
- `sharedDocs`: titles only — docs I own with a `DocumentInvite` for the person, plus docs where I hold an invite and the owner's user email = person (single-tenant: resolve owner via `Document.userId → users.email`). `{id, title, emoji, direction: 'i-shared' | 'they-shared'}`.

Email param validated + lowercased; own address rejected. No AI, no caching — it's a handful of indexed queries.

## API — AI streams (chat module)

Two endpoints in `apps/api/src/chat/` beside `/ai/ask`, reusing its SSE/char-stream shape, `PublicChatSource` typed chips, prompt fencing, injection detection, and no-context short-circuit. Both also get a cache-read `GET`.

**`POST /ai/dossier`** body `{email}`:
- Context legs (`allSettled`, per-leg degraded): (a) last 15 messages to/from the person — card gist where a `MessageCard` exists, else snippet — fenced EMAIL with alias tags; (b) open commitments both ways; (c) shared events next 30 days, fenced EVENT.
- Prompt asks for a short relationship narrative: current state, communication cadence, open loops in both directions, anything time-sensitive. Cite aliases.
- On successful completion the service upserts the `ai_generations` row (`kind: 'dossier'`, `targetKey: email`, `sourceAnchor` = newest `receivedAt` seen in leg (a), sources snapshot included).

**`GET /ai/dossier?email=`** → `{content, sources, generatedAt, stale} | null` from cache.

**`POST /ai/meeting-prep`** body `{eventId}`:
- Event loaded and **ownership verified before any retrieval** (404 on miss, mirroring `verifyReadAccess`-before-headers from 3a).
- Context legs: (a) event itself — title/description/location/attendees, fenced EVENT; (b) per-attendee recent mail (top 5 per attendee, capped 20 total, via the new fromEmail index; the user's own address skipped); (c) open commitments involving any attendee; (d) vector leg — embed `title + description` once, run the existing mail-vec + doc-vec legs from `RetrievalService` (doc leg keeps its query-time owner-OR-invite ACL); (e) the `linkedMessageId` message when set.
- Output prompt: a structured pack — **What this meeting is about · Attendees & open loops (per person) · Recent context · Suggested talking points** — grounded-or-say-so, alias citations.
- On completion: upsert `kind: 'meeting_prep'`, `targetKey: eventId`, `sourceAnchor = max(event.updatedAt, newest receivedAt in legs b/e)`.

**`GET /ai/meeting-prep?eventId=`** → cached pack + `stale` flag (ownership verified).

Token budgets mirror ask: shared clamp helper in the service, total context budget ~12k chars, per-source snippet caps unchanged. `CHAT_MODEL` / `OLLAMA_BASE_URL` env reused; no new env vars.

## Web

**Store:** `apps/web/stores/people.store.ts` — `{ open, email, openDossier(email), close }`, plus per-email narrative state (cached content, streaming buffer, stale flag). Same single-mount pattern as `ask.store`.

**`PersonDossierPanel`** (`apps/web/components/people/PersonDossierPanel.tsx`), mounted once in `app/(app)/layout.tsx` beside `AskLauncher`; docked right, `fixed` at all breakpoints with the `xl:pr-[420px]` reservation pattern from AskPanel (the two panels never open simultaneously — opening one closes the other via their stores).
- Header: avatar initials, display name, email, last-interaction line.
- Facts sections from `GET /people/dossier`: Recent conversations (row click → mail thread), Open loops (promised/waiting chips → source message), Shared events (→ `/calendar?event=` deep link), Shared docs (→ `/docs?open=`).
- AI block: cached narrative renders with generated-at + amber `stale` badge and a Regenerate button; otherwise a "Summarize relationship" button streams via the new client. Injection banner behavior identical to Ask.

**Entry points:** sender name/avatar in `ThreadMessage.tsx` / `MailDetail.tsx` becomes a button → `openDossier(fromEmail)`; attendee rows in the calendar page's `EventDetailPanel` do the same. Entry points added this phase stop here — more (MailList hover, contacts page) are follow-ups.

**Prep pack UI:** inside `EventDetailPanel` — a "Prep" button. On click: cached pack (from `GET /ai/meeting-prep`) renders instantly with generated-at + stale badge + Regenerate; otherwise streams. Rendered as the same lightweight markdown treatment Ask answers use; source chips navigate through `sourceNav` (EMAIL → thread, DOCUMENT → doc, EVENT → calendar).

**Client:** `lib/ai/generation.ts` — `streamDossier` / `streamMeetingPrep` mirroring `streamAsk` (fetch-SSE, abort, degraded + injection flags), plus `api.people.dossier`, `api.ai.getDossier/getMeetingPrep` namespaces in `lib/api.ts`.

## Out of scope (follow-ups)

- Alias merging / person entities spanning multiple addresses; org-level views.
- A `/people` directory page; MailList hover cards; contacts-page dossier entry.
- Pre-generation worker for tomorrow's meetings; briefing-strip "Prep" shortcuts.
- `toRecipients` GIN index (revisit when sent-mail scans slow down).
- Dossier for the user themself; group/DL addresses treated specially (v1 treats a DL as a person).
- The 3a debt list (docId-scoped chunk depth, "Ask your inbox" copy, live-DB ACL test) stays tracked separately.

## Testing

- **api (jest):** people service — fromEmail match both directions, JSONB attendee/organizer match, commitment join + open-only filter, sharedDocs direction split incl. revoked-invite miss, own-address 400, email validation; ai_generations — upsert on completion, staleness compute (newer mail → stale, untouched → fresh, event.updatedAt bump → stale); meeting-prep — ownership 404 before retrieval, per-attendee cap, linked-message leg, degraded flags; dossier — leg assembly, no-context short-circuit, cache write. Controller DTO validation for both endpoints.
- **web (vitest):** people store transitions (open/close, ask-panel mutual exclusion), `streamDossier`/`streamMeetingPrep` request shape + abort, dossier panel states (facts render, cached vs stream vs stale badge), prep view states, chip navigation mapping.
- Suites stay green: web 405+, api 202+; `npx tsc --noEmit` both apps; containerized builds (api tarball keeps its 126 `.prisma/client` entries — guard with `find -maxdepth 6`).

## Deploy notes

One migration (`add_people_phase3b`) — ship api bundle + `prisma migrate deploy` on both VMs (.155 via Bruce's `!` script; its PG is on 5433). No new env vars. No worker changes — nothing to restart beyond the usual api/web units.
