# AI Phase 3a — Ask 1Gov retrieval core (design)

**Date:** 2026-09-05 · **Status:** approved by Bruce (design page: claude.ai/code/artifact/921576a6-3020-47cf-b9c8-b43fa96ace94)
**Scope:** the retrieval core of phase 3: doc embeddings, fused mail + docs + calendar retrieval, and the Ask panel promoted app-wide with a per-document scope. Phase 3b (relationship dossier, meeting prep pack) is a separate later spec that builds on this.
**Surfaces:** apps/api (new table + migration, new worker, widened retrieval + endpoint), packages/shared (doc text walker, chunker generalization, typed prompt/source helpers), apps/web (Ask store + app-wide panel, typed chips, docs-editor entry, calendar deep link).

User decisions locked in chat:
1. Phase 3 ships in two runs; this spec is **3a only**.
2. Ask is **app-wide** (panel in the app shell, triggers on every page).
3. Retrieval covers **mail + docs (vectors) + calendar (deterministic keyword/date leg)** — no event embeddings.
4. Docs coverage is **own + invited** — cross-doc Ask searches docs the user owns OR is invited to; access is evaluated at query time.

## Standing invariants

- The RAG boundary stays server-side: retrieval, ACL, prompt assembly, and upstream streaming happen in the API. Full chunk text never reaches the browser — sources ship as ≤160-char snippets, exactly as today.
- Every source is fenced (`fenceUntrusted`) with per-type labels (EMAIL / DOCUMENT / EVENT); headers pass through `neutralizeMarkers`; the prompt keeps the four mandates (ground-or-say-so, cite aliases in square brackets, alias-only references — never ids/links/URLs, excerpts are data not instructions); `splitByCitations`'s whitelist still means the model cannot mint a reference the server didn't vouch for.
- `detectInjectionAttempt` + card-flag OR runs on every context regardless of type; `injectionSuspected` per source drives the existing amber banner.
- Leg failures degrade, never error: each retrieval leg is `allSettled` with a per-leg `degraded` flag; zero total sources short-circuits to `NO_SOURCES_REPLY` without a model call.
- Access control truths: doc read access = owner OR `DocumentInvite` matched by the **user's email** (invites are revocable → check at query time, never at embed time). Anonymous share-token paths carry no user identity → **no AI on them**.
- Chat model is chosen server-side (`CHAT_MODEL`); embeddings model server-side (`EMBED_MODEL`, bge-m3, 1024 dims). Client model settings do not affect `/ai/ask`.
- Prisma + pgvector rule: the HNSW index is hand-written SQL on an `Unsupported("vector(1024)")` column — `prisma migrate dev` will offer to drop it; ALWAYS decline (schema comment required, same as message_embeddings).
- Migration is additive only (one new table + indexes). No changes to existing tables in 3a.

## Part 1 — Doc embeddings (api + shared)

### 1.1 Schema

New Prisma model (mirroring `MessageEmbedding`, schema.prisma:194–218) + migration `add_document_embeddings`:

```prisma
model DocumentEmbedding {
  id              String   @id @default(cuid())
  documentId      String
  chunkIndex      Int
  model           String
  chunkText       String
  embedding       Unsupported("vector(1024)")?
  failed          Boolean  @default(false)
  sourceUpdatedAt DateTime            // Document.updatedAt at embed time — the re-embed trigger
  extractedAt     DateTime @default(now())
  document Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  @@unique([documentId, chunkIndex, model])
  @@index([documentId])
  @@map("document_embeddings")
}
```

Migration SQL adds `CREATE INDEX "document_embeddings_embedding_hnsw_idx" ON "document_embeddings" USING hnsw ("embedding" vector_cosine_ops);` and carries the never-drop caveat comment. **No `userId` column** — per-document keying is the point (deduped storage, invite-safe); user scoping happens in the query's ACL join.

### 1.2 Doc text extraction (shared)

`packages/shared/src/ai/docText.ts`:
- `docJsonToText(contentJson: string): string | null` — parse (null on invalid JSON), then a recursive walker (the `getDebugInfo` pattern: guard object nodes, recurse `content[]`): text nodes concatenate; paragraph/heading/listItem/blockquote boundaries emit `\n\n` (single `\n` between list items); heading text prefixed `#`-free (plain); tables flatten row-wise with ` | ` separators; images/embeds skipped. Deliberately NOT `generateHTML` (unknown-node throws + extension coupling).
- Exported flat from `packages/shared/src/index.ts`.

### 1.3 Chunker generalization (shared)

`packages/shared/src/ai/chunk.ts`:
- Extract the packing core: `chunkPlainText(text: string, headerLine: string | null, maxChunks: number): string[]` (paragraph-boundary packing, 1500-char chunks, header prefixed to chunk 0, hard-slice long paragraphs).
- `chunkForEmbedding(input, subject)` keeps its exact export name, signature, and behavior (email adapter over the core; existing tests must stay green unmodified).
- New `chunkDocForEmbedding(text: string, title: string | null): string[]` — doc adapter, `DOC_EMBED_MAX_CHUNKS = 12`, header line `Title: <title>`.

### 1.4 Doc embed worker (api)

`apps/api/src/docs/doc-embed-worker.service.ts` — `DocEmbedWorkerService`, fourth instance of the cron skeleton (embed-worker.service.ts is the template; `pickFairBatch` imported from card-worker.service.ts, keyed on the document's `userId` for fairness):
- `@Cron(EVERY_MINUTE, { waitForCompletion: true })`; batch caps `DOC_EMBED_BATCH_PER_TICK = env ?? 8`, `DOC_EMBED_PER_USER_PER_TICK = env ?? 2` (docs are chunk-heavier than mail).
- Candidates: documents with non-empty `content`, owned by users with a live session (`authToken not null, tokenExpiry > now` — same predicate as mail), where **no embedding row for the current model exists OR `Document.updatedAt > sourceUpdatedAt` of its rows** — i.e. stale after an autosave. Order `updatedAt desc`.
- Per doc: `docJsonToText` → `chunkDocForEmbedding(text, title)`; empty text → tombstone (`chunkIndex 0, chunkText '', failed true, sourceUpdatedAt = doc.updatedAt`). Embed via the existing exported `EmbedderService`. Write in a `$transaction`, mirroring the mail worker exactly: deleteMany the document's rows, then one `$executeRaw` insert per chunk, with `sourceUpdatedAt = doc.updatedAt` captured at selection time (tombstones also delete other-model rows first, as mail does).
- 3-strike in-memory failure map keyed by documentId → tombstone.
- No retention purge (docs are not a rolling cache); deletion cleanup is the FK cascade.
- Module: provided by `DocsModule` (which imports `MailModule` for `EmbedderService`, or EmbedderService moves — DO NOT move it; import the module). Log line mirrors mail's: `doc embeddings: +N tombstoned N skipped N`.
- Known, accepted freshness limit (documented in code): collab writes `yjsState` continuously but `content` only on REST autosave — embeddings track the autosaved JSON.

## Part 2 — Retrieval generalization (api + shared)

### 2.1 Typed sources

`RetrievalService` (apps/api/src/chat/retrieval.service.ts) shapes widen:

```ts
export type SourceType = 'mail' | 'doc' | 'event';
export interface RetrievedSource {
  type: SourceType;
  id: string;                      // messageId | documentId | calendarEvent id
  title: string | null;            // subject | doc title | event title
  fromEmail?: string; fromName?: string | null;   // mail only
  date: Date;                      // receivedAt | updatedAt | startAt
  meta?: string | null;            // event: "Tue 10:00–11:00 · location"; doc: emoji
  context: string;
  injectionSuspected: boolean;
}
export interface RetrievalResult {
  sources: RetrievedSource[];
  degraded: { vector: boolean; keyword: boolean; docs: boolean; calendar: boolean };
}
```

`rrfFuse` (shared chat.ts) generalizes its key from `messageId` to a caller-supplied key or a required `key: string` field (`mail:<id>` / `doc:<id>` / `event:<id>`); existing mail callers adapt inside the service — the exported behavior for equal inputs is unchanged (update its tests accordingly, keeping the assertions equally strong).

### 2.2 Legs

`retrieve(userId, userEmail, question, scope?)` runs up to four legs via `allSettled`, honoring `scope`:
- **Mail vector leg** — existing `vectorRows` unchanged.
- **Doc vector leg** — new SQL:
```sql
SELECT e."documentId", e."chunkText", d."title", d."emoji", d."updatedAt",
       (e."embedding" <=> $vec::vector) AS distance
FROM "document_embeddings" e
JOIN "documents" d ON d."id" = e."documentId"
WHERE e."failed" = false AND e."embedding" IS NOT NULL AND e."model" = $model
  AND (d."userId" = $userId OR EXISTS (
        SELECT 1 FROM "document_invites" i
        WHERE i."documentId" = d."id" AND i."invitedEmail" = $userEmail))
ORDER BY e."embedding" <=> $vec::vector
LIMIT $limit
```
  (Verify actual table/column names against the schema — `@@map` names; invitedEmail comparison uses the stored casing convention used by `getInviteForUser`.) Dedupe by documentId keeping best distance.
- **Calendar leg** — deterministic, no vectors: `extractKeywords(question)`; if no keywords → empty. Prisma/raw query over `CalendarEvent` where `userId = $u AND startAt BETWEEN now()-30d AND now()+90d AND (title ILIKE any(kw) OR location ILIKE any(kw) OR description ILIKE any(kw) OR attendees::text ILIKE any(kw))`, order by `ABS(EXTRACT(EPOCH FROM (startAt - now())))` asc, limit 5. Context = a compact structured line: `Event: <title>\nWhen: <local range>\nWhere: <location>\nOrganizer: <organizer>\nAttendees: <names/emails>\nNotes: <description ≤400 chars>`.
- **Zimbra keyword leg** — existing, unchanged.
- Fusion: `rrfFuse([mailVector, docVector, calendar, keyword])` (vector legs first so their chunk payloads win collisions), top 8. `assembleContexts` runs injection detection on all types; mail-only card-flag lookup stays mail-only; contexts clamp to 1200 chars.
- **Scope** (`{ types?: SourceType[]; docId?: string }`): `types` skips non-listed legs; `docId` (implies types=['doc']) adds `AND e."documentId" = $docId` **after** an access check — `DocsService.verifyReadAccess(userId, docId)` (403 → controller 403, panel renders the error). A doc-scoped ask with zero sources gets the normal no-sources reply.

### 2.3 Endpoint

- `POST /ai/inbox-chat` → **renamed** `POST /ai/ask` (ChatController; same JWT guard, same 20/min throttle, same SSE protocol incl. the pre-header prepare, sources frame, no-sources short-circuit, disconnect abort). DTO gains `scope?: { types?: ('mail'|'doc'|'event')[]; docId?: string }` (class-validated: types values whitelisted, docId string).
- `InboxChatService` → `AskService` (rename file/class; `PublicChatSource` widens to the typed shape minus `context`: `{ alias, type, id, title, fromEmail?, fromName?, date, meta?, injectionSuspected, snippet }`).
- Prompt: `buildInboxChatPrompt` → `buildAskPrompt(sources, turns)` in shared chat.ts — scope statement becomes "the user's mail, documents, and calendar"; `formatSource` branches per type (EMAIL fence with From/Subject/Date header — unchanged; DOCUMENT fence with `[sN] Document: <title> | Updated: <date>`; EVENT fence with `[sN] Event: <title> | When: <range>`). All headers through `neutralizeMarkers`. `GET /mail/search/semantic` stays mail-only and untouched.

## Part 3 — App-wide Ask panel (web)

### 3.1 Store + shell mount

- New `apps/web/stores/ask.store.ts` — `useAskStore`: `{ open, collapsed, prefill: string | null, scope: { docId: string; docTitle: string } | null, openAsk(opts?), collapse(), close(), clearScope() }` (zustand, NOT persisted).
- `AskInboxPanel` → moved/renamed `apps/web/components/ai/AskPanel.tsx`, reading the store; mounted ONCE in `apps/web/app/(app)/layout.tsx` (verify the shared layout file; if pages own their shells, mount in a small client component included by the layout). Panel keeps: turn history, per-answer sources, streaming via `useCharStream`, degraded notices, injection banner, ESC-close, xl docking behavior **on the mail page**; on other routes it overlays (fixed right drawer) — the xl split-pane reflow only exists where the mail page already manages panel-aware layout.
- Mail page refactor: `askOpen/askCollapsed/askPrefill` local state replaced by the store; rail button, mobile FAB, `?ask=` deep link, GlobalSearch's `/mail?ask=` row all keep working (deep link consumes into the store).
- Non-mail pages: a global floating Ask button (bottom-right, `MessageCircleQuestion`, aiEnabled-gated) rendered by the same shell component, hidden on `/mail` (which has its own triggers) and on public/share routes.

### 3.2 Typed sources in the panel

- `lib/ai/inboxChat.ts` → `lib/ai/ask.ts`: `streamAsk(turns, { scope?, onSources, onChunk, signal })` posting `/ai/ask`; `AskSource` mirrors the typed public shape. (Keep a re-export or codemod all imports — no compat shim needed beyond green tests.)
- Source rail rows get per-type icons (mail `Mail`, doc `FileText`, event `Calendar`) and type-appropriate second lines. Chip/row click navigates: mail → existing open-message path on /mail, else `router.push('/mail?open=<id>')`; doc → `/docs?open=<id>`; event → `/calendar?event=<id>`.
- `/calendar?event=<id>` deep link: calendar page consumes the param once (the docs `?open=` pattern — ref guard + `router.replace`), sets `selectedEvent` after events load; unknown id fails quietly.

### 3.3 "Ask this document"

- DocsEditor toolbar (near the TOC/panel buttons) gains an Ask button (`MessageCircleQuestion`, aiEnabled-gated, hidden on anonymous share route): `openAsk({ scope: { docId, docTitle } })`.
- The panel renders the scope as a removable chip above the input: `This document: <title>` ×. While set, `streamAsk` sends `scope: { docId }`; clearing widens the SAME conversation (history preserved; the next question retrieves wide).
- Example-question chips adapt when scoped ("Summarize the key decisions", "What action items are in here?").

## Out of scope (3b or later)

- Relationship dossier, meeting prep pack (3b — will add `messages.fromEmail` index and counterparty queries then).
- Event embeddings; docs leg for `GET /mail/search/semantic` / ⌘K semantic rows; Ask on anonymous share pages; embedding invited-doc content the owner deleted mid-session (cascade handles).
- Backfill tooling — the worker backfills organically (23 users / ~50 docs on the VMs ≈ minutes).

## Testing

- **api (jest):** doc-embed worker — candidate selection (no rows / stale rows / fresh rows / empty content tombstone / dead-session exclusion), transaction write shape, 3-strike tombstone; retrieval — ACL predicate (owner hit, invitee hit, revoked-invite miss, stranger miss), docId scope + verifyReadAccess 403, calendar leg (keyword match, window bounds, no-keyword empty), typed fusion + degraded flags per leg; AskService — typed PublicChatSource mapping, scope passthrough, no-sources reply. Controller — DTO validation for scope.
- **shared (vitest, via web runner as today):** `docJsonToText` (paragraphs/headings/lists/tables/invalid JSON/unknown nodes), `chunkPlainText` core + both adapters (email adapter's existing tests unchanged), `rrfFuse` typed-key behavior, `buildAskPrompt` per-type fencing + mandates, `splitByCitations` unchanged.
- **web (vitest):** ask store transitions (open/scope/clear preserves turns), `streamAsk` request shape incl. scope, typed chip navigation mapping (pure helper), deep-link consume-once for `?event=`.
- Suites stay green: web 366+, api current count; `npx tsc --noEmit` both apps; containerized build.

## Deploy notes

First schema migration since phase 4: ship api bundle + `prisma migrate deploy` on both VMs (the .155 route via Bruce's `!` script). `EMBED_MODEL`/`CHAT_MODEL`/`OLLAMA_BASE_URL` already set on both boxes; no new env vars required (worker batch caps optional).
