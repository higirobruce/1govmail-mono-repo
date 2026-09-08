# AI Phase 3a — Ask 1Gov Retrieval Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Doc embeddings beside the mail ones, one server-side RAG endpoint fusing mail + docs + calendar with typed cited sources, and the Ask panel promoted app-wide with a per-document scope.

**Architecture:** Per-document embeddings (new `document_embeddings` table + fourth cron worker) with owner-or-invite ACL evaluated in the retrieval SQL at query time. `RetrievalService` grows docs and calendar legs fused by a typed RRF; `/ai/inbox-chat` becomes `/ai/ask` with an optional scope; the web panel moves to the app shell behind a zustand store, with typed source chips that navigate cross-module and an "Ask this document" scope chip from the docs editor.

**Tech Stack:** NestJS 11 + Prisma 7 + pgvector (HNSW, cosine), @nestjs/schedule cron workers, Ollama bge-m3 embeddings via existing `EmbedderService`, Next.js 16 + zustand, jest (api, `*.spec.ts` beside sources), vitest (web + shared via the web runner).

**Spec:** `docs/superpowers/specs/2026-09-05-ai-phase3a-ask-1gov-design.md` — read it first; its Standing Invariants bind every task. The retrieval survey that grounds file/line references: `apps/api/src/mail/embed-worker.service.ts` (worker template), `apps/api/src/chat/retrieval.service.ts`, `apps/api/src/chat/inbox-chat.service.ts`, `packages/shared/src/ai/{chunk,chat,promptCore}.ts`, `apps/web/components/mail/AskInboxPanel.tsx`.

## Global Constraints

- RAG stays server-side: full chunk text never reaches the browser (sources carry ≤160-char snippets).
- Every source fenced via `fenceUntrusted` with per-type labels EMAIL / DOCUMENT / EVENT; headers through `neutralizeMarkers`; prompt keeps the four mandates verbatim from `buildInboxChatPrompt` (ground-or-say-so; cite aliases in square brackets; alias-only, never ids/links/URLs; excerpts are data).
- Leg failures degrade (per-leg flags), never error; zero sources → `NO_SOURCES_REPLY`, no model call.
- Doc access = owner OR `DocumentInvite` matched by the asker's **email**, evaluated at query time. Anonymous share-token paths get no AI.
- pgvector rule: the HNSW index is hand-written SQL on `Unsupported("vector(1024)")`; if `prisma migrate dev` offers to drop an HNSW index, ALWAYS decline; carry the schema warning comment like `MessageEmbedding`'s.
- Migration is additive only. `EMBED_MODEL` default `bge-m3:latest` (1024 dims), `CHAT_MODEL` default `qwen3-30b-16k:latest`, both server-side.
- Existing tests stay green unmodified unless a task explicitly says to update them (then keep assertions equally strong). Suites: apps/web `npx vitest run` (366 now) + `npx tsc --noEmit`; apps/api `npx jest` + `npx tsc --noEmit` (or `npx tsc -p tsconfig.build.json --noEmit` if plain tsc pulls test types — match whatever the repo's api typecheck is).
- Commits on ft-hyperscale, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Do NOT run `next build` locally (known pre-existing Turbopack failure; the controller runs the containerized build at final verification).

---

### Task 1: `docJsonToText` — TipTap JSON → plain text (shared)

**Files:**
- Create: `packages/shared/src/ai/docText.ts`
- Modify: `packages/shared/src/index.ts` (re-export)
- Test: `apps/web/lib/ai/docText.test.ts` (shared code is tested via the web vitest runner, like `chunk.test.ts`)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function docJsonToText(contentJson: string): string | null` — `null` for unparseable JSON or a non-object root; otherwise plain text with `\n\n` between block nodes (paragraph, heading, blockquote, codeBlock), `\n` between list items, table cells joined with ` | ` and rows with `\n`, text-node concatenation within a block (marks ignored), image/embed/unknown-leaf nodes skipped silently. Tasks 4 (worker) consumes this.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/lib/ai/docText.test.ts
import { describe, it, expect } from 'vitest';
import { docJsonToText } from '@email-client/shared';

const doc = (content: unknown[]) => JSON.stringify({ type: 'doc', content });
const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

describe('docJsonToText', () => {
  it('joins paragraphs with blank lines', () => {
    expect(docJsonToText(doc([p('one'), p('two')]))).toBe('one\n\ntwo');
  });
  it('renders headings and blockquotes as blocks', () => {
    const out = docJsonToText(doc([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Decisions' }] },
      { type: 'blockquote', content: [p('quoted')] },
    ]));
    expect(out).toBe('Decisions\n\nquoted');
  });
  it('renders list items line by line', () => {
    const out = docJsonToText(doc([{
      type: 'bulletList', content: [
        { type: 'listItem', content: [p('alpha')] },
        { type: 'listItem', content: [p('beta')] },
      ],
    }]));
    expect(out).toContain('alpha\nbeta');
  });
  it('flattens tables row-wise with cell separators', () => {
    const cell = (t: string) => ({ type: 'tableCell', content: [p(t)] });
    const out = docJsonToText(doc([{
      type: 'table', content: [
        { type: 'tableRow', content: [cell('a'), cell('b')] },
        { type: 'tableRow', content: [cell('c'), cell('d')] },
      ],
    }]));
    expect(out).toContain('a | b');
    expect(out).toContain('c | d');
  });
  it('skips unknown/image nodes without throwing', () => {
    const out = docJsonToText(doc([p('before'), { type: 'image', attrs: { src: 'x' } }, { type: 'weirdWidget' }, p('after')]));
    expect(out).toBe('before\n\nafter');
  });
  it('returns null on invalid JSON and non-object roots', () => {
    expect(docJsonToText('not json')).toBeNull();
    expect(docJsonToText('42')).toBeNull();
  });
  it('returns empty string for an empty doc', () => {
    expect(docJsonToText(doc([]))).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify failure** — from `apps/web`: `npx vitest run lib/ai/docText.test.ts` → FAIL (no export).

- [ ] **Step 3: Implement.** Recursive walker (the `apps/api/src/docs/docs.service.ts` `getDebugInfo` visit-pattern is the in-repo precedent): collect block strings; a block's inline text = depth-first concat of `text` fields; `listItem` blocks within a list join with `\n`; table: rows join cells with ` | `; final join of top-level blocks with `\n\n`, trimmed; collapse runs of 3+ newlines to `\n\n`. Guard every node access (`typeof n === 'object' && n !== null`, `Array.isArray(n.content)`). Re-export from `packages/shared/src/index.ts`.

- [ ] **Step 4: Verify** — focused test PASS; from apps/web `npx tsc --noEmit` and `npx vitest run` green.

- [ ] **Step 5: Commit** — `feat(shared): docJsonToText — safe TipTap-JSON→plain-text walker`

---

### Task 2: Chunker generalization (shared)

**Files:**
- Modify: `packages/shared/src/ai/chunk.ts`
- Modify: `packages/shared/src/index.ts` (export new symbols)
- Test: extend `apps/web/lib/ai/chunk.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function chunkPlainText(text: string, headerLine: string | null, maxChunks: number): string[]` (the extracted packing core: paragraph-boundary packing into ≤`EMBED_CHUNK_MAX_CHARS` (1500) chunks, header prefixed to chunk 0 as `<headerLine>\n`, over-long paragraphs hard-sliced, cap at maxChunks); `export const DOC_EMBED_MAX_CHUNKS = 12`; `export function chunkDocForEmbedding(text: string, title: string | null): string[]` (header `Title: <title>` when title non-empty, cap `DOC_EMBED_MAX_CHUNKS`). **`chunkForEmbedding(input, subject)` keeps its exact current export, signature, and output** — it becomes a thin adapter (extractEmailText → `chunkPlainText(text, subject ? 'Subject: ' + subject : null, EMBED_MAX_CHUNKS)`). Task 4 consumes `chunkDocForEmbedding`.

- [ ] **Step 1: Write failing tests** (append to `chunk.test.ts`; do not touch existing cases):

```ts
describe('chunkDocForEmbedding', () => {
  it('prefixes the title to chunk 0 only', () => {
    const chunks = chunkDocForEmbedding('para one\n\npara two', 'My Doc');
    expect(chunks[0].startsWith('Title: My Doc\n')).toBe(true);
    expect(chunks.length).toBe(1);
  });
  it('caps at DOC_EMBED_MAX_CHUNKS (12) for very long docs', () => {
    const long = Array.from({ length: 40 }, (_, i) => `paragraph ${i} ${'x'.repeat(1400)}`).join('\n\n');
    const chunks = chunkDocForEmbedding(long, null);
    expect(chunks.length).toBe(12);
    expect(Math.max(...chunks.map(c => c.length))).toBeLessThanOrEqual(1500 + 20);
  });
  it('returns [] for empty text', () => {
    expect(chunkDocForEmbedding('   ', 'T')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**, then extract `chunkPlainText` from the body of `chunkForEmbedding` WITHOUT changing the email path's behavior (the existing email tests are the regression harness — they must pass unmodified), add the doc adapter + constant, re-export.

- [ ] **Step 3: Verify** — `npx vitest run lib/ai/chunk.test.ts` all green (old + new); full web suite + tsc green.

- [ ] **Step 4: Commit** — `refactor(shared): extract chunkPlainText core; add doc chunk adapter (12-chunk cap)`

---

### Task 3: `document_embeddings` schema + migration (api)

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (new model + relation on `Document`)
- Create: `apps/api/prisma/migrations/<ts>_add_document_embeddings/migration.sql` (via `--create-only`, then hand-edit)

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma model `DocumentEmbedding` per the spec §1.1 verbatim — fields `id (cuid), documentId, chunkIndex Int, model String, chunkText String, embedding Unsupported("vector(1024)")?, failed Boolean @default(false), sourceUpdatedAt DateTime, extractedAt DateTime @default(now())`, relation to `Document` with `onDelete: Cascade`, `@@unique([documentId, chunkIndex, model])`, `@@index([documentId])`, `@@map("document_embeddings")`. `Document` gains `embeddings DocumentEmbedding[]`. Tasks 4 and 6 consume the table.

- [ ] **Step 1: Add the model** to schema.prisma next to `MessageEmbedding`, copying its warning comment block about the HNSW index and `migrate dev` (adapted to this table's index name).

- [ ] **Step 2: Create the migration without applying**: from `apps/api`: `npx prisma migrate dev --create-only --name add_document_embeddings`. Then append to the generated `migration.sql`:

```sql
-- Hand-written: Prisma cannot represent an index on an Unsupported() column.
CREATE INDEX "document_embeddings_embedding_hnsw_idx"
  ON "document_embeddings" USING hnsw ("embedding" vector_cosine_ops);
```

Confirm the generated SQL declares `"embedding" vector(1024)` and does NOT drop `message_embeddings_embedding_hnsw_idx` (if the diff proposes any DROP INDEX on an hnsw index, remove that statement and note it in your report).

- [ ] **Step 3: Apply + generate**: `npx prisma migrate dev` (against the local dev DB; decline/strip any HNSW drop as above), confirm `npx prisma generate` runs clean and `npx tsc --noEmit` in apps/api passes with the new client types.

- [ ] **Step 4: Sanity-check the index exists**: `npx prisma db execute --stdin <<< "SELECT indexname FROM pg_indexes WHERE tablename = 'document_embeddings';"` → must list the hnsw index and the unique.

- [ ] **Step 5: Run the api suite** (`npx jest`) — green (schema-only change), then commit — `feat(api): document_embeddings table with HNSW cosine index`

---

### Task 4: Doc embed worker (api)

**Files:**
- Create: `apps/api/src/docs/doc-embed-worker.service.ts`
- Modify: `apps/api/src/docs/docs.module.ts` (provider + `imports: [MailModule]` for `EmbedderService`; if that import creates a module cycle, report BLOCKED with the cycle path rather than restructuring)
- Test: `apps/api/src/docs/doc-embed-worker.service.spec.ts`

**Interfaces:**
- Consumes: `EmbedderService` (`apps/api/src/mail/embedder.service.ts` — `embed(texts): Promise<number[][]>`, `.model`, exported by `MailModule`); `pickFairBatch` (exported from `apps/api/src/mail/card-worker.service.ts:58`, keyed on `userId`); `docJsonToText`, `chunkDocForEmbedding` from `@email-client/shared`; `PrismaService`.
- Produces: `DocEmbedWorkerService` with `@Cron(CronExpression.EVERY_MINUTE, { waitForCompletion: true }) tick()` and a testable `processTick(): Promise<{ embedded: number; tombstoned: number; skipped: number }>`. Constants `DOC_EMBED_BATCH_PER_TICK = Number(process.env.DOC_EMBED_BATCH_PER_TICK ?? 8)`, `DOC_EMBED_PER_USER_PER_TICK = Number(process.env.DOC_EMBED_PER_USER_PER_TICK ?? 2)`, `FAILURE_LIMIT = 3` (in-memory Map keyed by documentId).

Behavior (mirror `EmbedWorkerService` structurally — read it first):
- Candidates: `prisma.document.findMany` where `content` is non-null and non-empty string, owner has a live session (`user: { authToken: { not: null }, tokenExpiry: { gt: new Date() } }`), and the doc needs (re)embedding for the current model. Prisma can't compare two columns, so select candidates broadly (`orderBy: { updatedAt: 'desc' }, take: BATCH*4`, `select: { id, userId, title, updatedAt, content, embeddings: { where: { model }, select: { sourceUpdatedAt: true }, take: 1 } }`) and filter in JS: keep docs with zero rows for the model OR `doc.updatedAt > row.sourceUpdatedAt`. Then `pickFairBatch(candidates, PER_USER, BATCH)`.
- Per doc: `docJsonToText(content)`; null/empty text → tombstone (delete other-model rows, upsert `{chunkIndex: 0, chunkText: '', failed: true, sourceUpdatedAt: doc.updatedAt}` for current model). Else `chunkDocForEmbedding(text, title)` → `embedder.embed(chunks)` → `$transaction`: `documentEmbedding.deleteMany({ where: { documentId } })` then one `$executeRaw` INSERT per chunk (`${'[' + vec.join(',') + ']'}::vector`, `sourceUpdatedAt = doc.updatedAt`).
- Errors per doc increment the failure map; at 3 strikes tombstone. Log `doc embeddings: +N tombstoned N skipped N`.

- [ ] **Step 1: Write the failing spec** — mirror `apps/api/src/mail/embed-worker.service.spec.ts`'s mocking style (mock PrismaService + EmbedderService). Cases: (a) fresh doc with no rows → embedded, transaction delete+N inserts, sourceUpdatedAt = doc.updatedAt; (b) doc with rows where `updatedAt` ≤ `sourceUpdatedAt` → filtered out (skipped, no embed call); (c) stale doc (`updatedAt` > `sourceUpdatedAt`) → re-embedded; (d) empty/invalid content → tombstone written, embedder never called; (e) embedder throws 3 ticks running → tombstone on the third; (f) fairness: 5 docs from user A + 1 from user B with PER_USER=2 → batch contains B's doc.

- [ ] **Step 2: Run to verify failure** — from `apps/api`: `npx jest src/docs/doc-embed-worker.service.spec.ts` → FAIL.

- [ ] **Step 3: Implement + wire the module.**

- [ ] **Step 4: Verify** — focused spec PASS; full `npx jest` + `npx tsc --noEmit` green. Optionally run the api locally for one tick if a dev DB with docs exists — otherwise state that live verification lands with the deploy.

- [ ] **Step 5: Commit** — `feat(api): doc embed worker — per-document vectors, autosave-triggered re-embeds`

---

### Task 5: Shared chat helpers go typed (shared)

**Files:**
- Modify: `packages/shared/src/ai/chat.ts`
- Modify: `packages/shared/src/index.ts`
- Test: extend the existing shared-chat tests (find them: `grep -rl "rrfFuse\|buildInboxChatPrompt" apps/web/lib` — likely `inboxChatCore.test.ts`)

**Interfaces:**
- Consumes: `fenceUntrusted`, `neutralizeMarkers`, `languageRule` (already imported there).
- Produces (Tasks 6–7 rely on exactly):

```ts
export type SourceType = 'mail' | 'doc' | 'event';
export interface ChatSource {            // widened; existing mail fields stay
  alias: string; type: SourceType; id: string;
  title: string | null;                  // subject / doc title / event title
  fromEmail?: string; fromName?: string | null;   // mail only
  date: string | Date;
  meta?: string | null;                  // event when/where line, doc emoji
  context: string; injectionSuspected: boolean;
}
export function rrfFuse<T extends { key: string }>(legs: T[][], k = 60, top = 8): T[];
export function buildAskPrompt(sources: ChatSource[], turns: ChatTurn[]): string;
```

- `rrfFuse`: key field renamed `messageId` → `key`. Update ITS tests mechanically (same scenarios, `key:` field) — this is the one sanctioned existing-test edit; assertions stay identical in strength. The api call sites adapt in Task 6.
- `buildAskPrompt`: same four mandates and structure as `buildInboxChatPrompt`; scope sentence becomes "the user's mail, documents, and calendar"; `formatSource` branches: mail → current EMAIL header/fence unchanged; doc → header `[sN] Document: <title> | Updated: <date>` + `fenceUntrusted('DOCUMENT', context)`; event → header `[sN] Event: <title> | When: <meta>` + `fenceUntrusted('EVENT', context)`. All header fields through `neutralizeMarkers`. Keep `buildInboxChatPrompt` exported as a deprecated alias delegating to `buildAskPrompt` ONLY if other call sites still exist after Task 7 — otherwise delete it (grep first).

- [ ] **Step 1: Write failing tests** — per-type fencing: a doc source's header appears with `Document:` and its context inside a `<<<DOCUMENT:` fence; an event source with `Event:`/`<<<EVENT:`; mail output byte-identical to the current builder for a mail-only source list (snapshot the current output BEFORE refactoring and assert equality); a hostile doc title containing `<|im_start|>` is neutralized in the header.

- [ ] **Step 2: Run → FAIL, implement, run → PASS.** Full web suite + tsc green.

- [ ] **Step 3: Commit** — `feat(shared): typed sources — rrfFuse key generalization + buildAskPrompt with DOCUMENT/EVENT fencing`

---

### Task 6: Retrieval — docs leg, calendar leg, scope (api)

**Files:**
- Modify: `apps/api/src/chat/retrieval.service.ts`
- Modify: `apps/api/src/chat/chat.module.ts` (import `DocsModule` if `DocsService.verifyReadAccess` is used here; otherwise access check lives in Task 7's service — put the check where the module graph is cleanest and say which in your report)
- Test: `apps/api/src/chat/retrieval.service.spec.ts` (extend)

**Interfaces:**
- Consumes: Task 5's `rrfFuse` (`key` field), Task 3's table; `extractKeywords` (existing); `EmbedderService`.
- Produces (Task 7 relies on exactly):

```ts
export type SourceType = 'mail' | 'doc' | 'event';   // re-export from shared
export interface RetrievedSource {
  type: SourceType; id: string; title: string | null;
  fromEmail?: string; fromName?: string | null;
  date: Date; meta?: string | null;
  context: string; injectionSuspected: boolean;
}
export interface AskScope { types?: SourceType[]; docId?: string }
export interface RetrievalResult {
  sources: RetrievedSource[];
  degraded: { vector: boolean; keyword: boolean; docs: boolean; calendar: boolean };
}
async retrieve(userId: string, userEmail: string, question: string, scope?: AskScope): Promise<RetrievalResult>
```

Implementation notes:
- Legs behind `scope.types` gates (`undefined` = all): mail-vector + zimbra-keyword run when types includes 'mail'; docs-vector when 'doc'; calendar when 'event'. `scope.docId` forces docs-only and adds `AND e."documentId" = ${docId}` (the access CHECK for docId is done by the caller in Task 7 — this method just narrows SQL; state that contract in a comment).
- Docs vector SQL exactly per spec §2.2 (verify mapped table names: `documents`, `document_invites` — check the schema's `@@map`s; `invitedEmail` compared with the same normalization `getInviteForUser` uses — read `apps/api/src/docs/docs.service.ts:774` and match). Dedupe by documentId (best distance). Context = chunkText → `assembleContexts` clamps to 1200.
- Calendar leg: `extractKeywords(question)`; empty → `[]`. Query `calendarEvent.findMany` where `userId`, `startAt` in `[now-30d, now+90d]`, then JS-filter rows where any keyword (case-insensitive) appears in `title ?? '' + location ?? '' + description ?? '' + JSON.stringify(attendees)` (a JS filter over the windowed rows is fine — per-user event counts are small; avoids ILIKE-array SQL). Sort by `Math.abs(startAt - now)` asc, take 5. Context per spec: `Event: …\nWhen: <toLocaleString range>\nWhere: …\nOrganizer: …\nAttendees: names <emails>\nNotes: <desc ≤400>`. `meta` = the When line's value.
- Fusion: build leg arrays as `{ key: 'mail:'+id | 'doc:'+id | 'event:'+id, ... }`, `rrfFuse([mailVec, docVec, calendar, keyword])`, then `assembleContexts` (mail card-flag OR stays mail-only; `detectInjectionAttempt` on every context).
- `semantic()` (mail-only search endpoint) untouched.

- [ ] **Step 1: Write failing tests** extending the existing spec's mocking style: docs-leg SQL invoked with userId AND userEmail params; ACL scenarios via mocked `$queryRaw` capture (assert the SQL string contains the EXISTS invite predicate); scope.types=['doc'] skips mail/keyword/calendar mocks entirely; scope.docId adds the documentId clause; calendar leg matches keyword in title / in attendees JSON, respects the window, returns ≤5 ordered by proximity; one leg rejecting sets only its degraded flag while others' sources flow; typed keys fuse without collision (a doc and a mail with the same cuid don't merge).

- [ ] **Step 2: Run → FAIL, implement, run → PASS.** Full `npx jest` + api tsc green (the old `retrieve(userId, question)` call site in inbox-chat.service breaks — fix it minimally there to compile by passing the email through; Task 7 finishes that file).

- [ ] **Step 3: Commit** — `feat(api): retrieval gains docs leg (query-time ACL), calendar leg, and ask scope`

---

### Task 7: `/ai/ask` — service + controller rename, typed public sources (api)

**Files:**
- Rename/modify: `apps/api/src/chat/inbox-chat.service.ts` → `apps/api/src/chat/ask.service.ts` (class `AskService`)
- Modify: `apps/api/src/chat/chat.controller.ts`, `apps/api/src/chat/chat.module.ts`
- Modify: `apps/api/src/chat/dto/inbox-chat.dto.ts` → `ask.dto.ts` (add scope)
- Test: rename/extend the existing inbox-chat specs

**Interfaces:**
- Consumes: Task 6's `retrieve(userId, userEmail, question, scope)` + `RetrievedSource`; Task 5's `buildAskPrompt`; `DocsService.verifyReadAccess(userId, docId)` (`apps/api/src/docs/docs.service.ts:745`).
- Produces (web Task 8 relies on exactly):
  - Route: `POST /ai/ask` (JWT, `@Throttle 20/60s`), body `{ messages: [{role:'user'|'assistant', content(≤4000)}] (1..12), scope?: { types?: ('mail'|'doc'|'event')[], docId?: string } }` — class-validated (`@IsIn` each type, `@IsString` docId, whole scope `@IsOptional @ValidateNested`).
  - SSE protocol unchanged: pre-header prepare; `event: sources` frame `{ sources: PublicAskSource[], degraded }`; raw deltas; `[DONE]`; no-sources synthetic reply.
  - `PublicAskSource = { alias, type, id, title, fromEmail?, fromName?, date: string, meta?, injectionSuspected, snippet }` (snippet = context.slice(0,160); context stripped).
  - `scope.docId` → `verifyReadAccess` BEFORE retrieval; failure → 403 JSON (before headers flush). The user's email for the ACL comes from the JWT payload / user lookup — read how other services resolve the current user's email (e.g. `getInviteForUser` does `prisma.user.findUnique`) and do the same once per request.
  - Grep-and-update ALL web/api references to `inbox-chat` (`grep -rn "inbox-chat" apps packages`) — the web client updates in Task 8, so at THIS task's end the api serves `/ai/ask` and the old path is gone; note the temporary web breakage in your report (web still points at the old path until Task 8 — acceptable mid-plan on this branch; do not ship a compat alias).

- [ ] **Step 1: Failing tests first** — controller: scope validation (bad type value → 400; docId + failing verifyReadAccess → 403 before SSE); service: typed `PublicAskSource` mapping (doc source carries title/meta, no fromEmail; context stripped), scope passthrough to retrieve, no-sources reply unchanged, upstream body still `{ model: CHAT_MODEL, temperature 0.2, max_tokens 1024, stream: true }`.

- [ ] **Step 2: Run → FAIL, implement (rename files with `git mv`), run → PASS**; full jest + tsc green.

- [ ] **Step 3: Commit** — `feat(api): /ai/ask — typed sources, scoped retrieval, doc read-access gate`

---

### Task 8: Web ask store + typed client (web)

**Files:**
- Create: `apps/web/stores/ask.store.ts`
- Rename/modify: `apps/web/lib/ai/inboxChat.ts` → `apps/web/lib/ai/ask.ts` (update the two test files' imports)
- Test: `apps/web/stores/ask.store.test.ts` + the renamed `ask.test.ts`/`askCore.test.ts`

**Interfaces:**
- Consumes: `/ai/ask` (Task 7's shapes).
- Produces (Tasks 9–11 rely on exactly):

```ts
// stores/ask.store.ts
export interface AskScope { docId: string; docTitle: string }
interface AskState {
  open: boolean; collapsed: boolean;
  prefill: string | null; scope: AskScope | null;
  openAsk: (opts?: { prefill?: string; scope?: AskScope }) => void;  // opens, un-collapses, sets whichever fields are passed
  collapse: () => void; close: () => void; clearScope: () => void;   // clearScope keeps the panel open
}
export const useAskStore: ...  // zustand, not persisted

// lib/ai/ask.ts
export type AskSourceType = 'mail' | 'doc' | 'event';
export interface AskSource { alias: string; type: AskSourceType; id: string; title: string | null;
  fromEmail?: string; fromName?: string | null; date: string; meta?: string | null;
  injectionSuspected: boolean; snippet: string }
export interface AskDegraded { vector: boolean; keyword: boolean; docs: boolean; calendar: boolean }
export async function streamAsk(
  turns: AskTurn[],
  opts: { scope?: { docId: string } | null;
    onSources: (s: AskSource[], d: AskDegraded) => void;
    onChunk: (delta: string) => void; signal?: AbortSignal },
): Promise<string>   // POST /ai/ask body { messages, ...(scope ? { scope: { docId } } : {}) }; SSE parsing unchanged
```

- [ ] **Step 1: Failing tests** — store: `openAsk({scope})` sets scope + open; `clearScope` keeps open and turns unaffected (turns live in the panel, so just assert scope null + open true); `close` resets collapsed but PRESERVES scope? No — `close()` clears scope and prefill (a fresh open is unscoped unless asked). Encode exactly that. Client: request body contains `scope.docId` when given and omits `scope` when null (mock `authedFetch` capture, following the existing inboxChat test's fetch-mock style); typed sources from an `event: sources` frame reach `onSources`.

- [ ] **Step 2: Run → FAIL, implement (git mv the lib; mechanical import updates in its tests — keep every existing assertion), run → PASS**; full vitest + tsc green (AskInboxPanel still imports the old names — update its import in this task to keep the build green, without behavior change yet).

- [ ] **Step 3: Commit** — `feat(web): ask store + typed streamAsk client for /ai/ask`

---

### Task 9: App-wide AskPanel + typed chips (web)

**Files:**
- Rename/modify: `apps/web/components/mail/AskInboxPanel.tsx` → `apps/web/components/ai/AskPanel.tsx`
- Create: `apps/web/components/ai/AskLauncher.tsx` (shell mount: panel + global FAB)
- Create: `apps/web/lib/ai/sourceNav.ts` (+ test) — pure chip-navigation mapping
- Modify: `apps/web/app/(app)/layout.tsx` (mount AskLauncher — first read it; if no shared client boundary exists, add the component inside the layout's existing client shell)
- Modify: `apps/web/app/(app)/mail/page.tsx` (state → store; keep rail/FAB/deep-link behavior; pass mail-specific handlers)
- Test: `apps/web/lib/ai/sourceNav.test.ts`

**Interfaces:**
- Consumes: Tasks 8's store/client; existing panel internals (turns, SourcesRail, banners, useCharStream) move unchanged.
- Produces:

```ts
// lib/ai/sourceNav.ts
export function sourceHref(s: { type: AskSourceType; id: string }): string
// mail → `/mail?open=${id}` · doc → `/docs?open=${id}` · event → `/calendar?event=${id}`
```

Behavior:
- `AskPanel` reads open/collapsed/prefill/scope from the store. On the mail page it keeps today's xl split-pane docking and the mail-page callbacks (`onOpenMessage`/`onReplyToMessage` when provided); everywhere else it renders as the fixed right overlay and source-chip clicks `router.push(sourceHref(s))` (mail chips too, navigating to `/mail?open=`). Wire the mail page to pass its handlers; AskLauncher passes none.
- Source rail rows: per-type icon (`Mail`/`FileText`/`Calendar` from lucide) + second line = mail: from/date (unchanged); doc: `Document · updated <date>`; event: `meta` (the When line). Scope chip UI: when `scope` set, a removable chip `This document: <docTitle>` above the input calling `clearScope()`; while scoped, `streamAsk` gets `{ docId }`, and the example-question chips switch to doc-flavored ones ('Summarize the key decisions', 'What action items are in here?').
- `AskLauncher` (in the app layout): renders `<AskPanel/>` once + a floating Ask button (bottom-right, `MessageCircleQuestion`, `aiEnabled`-gated via the same store/hook the mail FAB uses) hidden on `/mail` (`usePathname()`), never on routes outside `(app)`.
- Mail page: delete local askOpen/askCollapsed/askPrefill; rail `onAsk`, mobile FAB, and the `?ask=` effect call `openAsk(...)`; the mail page no longer renders its own `<AskInboxPanel/>` (the launcher owns it). `?ask=` deep link and GlobalSearch's `/mail?ask=` row must still work (they do — the effect consumes into the store).
- `/mail?open=<id>` — VERIFY this deep link exists (the EventDetailPanel already links to it: `calendar/page.tsx` "Source email" uses `/mail?open=`). It does; reuse.

- [ ] **Step 1: sourceNav test first** (three mappings + URL-encoding of ids), implement, PASS.
- [ ] **Step 2: Move/rename the panel, build AskLauncher, refactor the mail page.** Keep the diff tight; the panel's internals (turn rendering, streaming, banners) move verbatim apart from the store/typed-source changes.
- [ ] **Step 3: Verify** — `npx tsc --noEmit`, full `npx vitest run` green. Manual checks are the controller's (note the skip): Ask opens from docs/tasks/calendar pages via FAB; mail behavior unchanged; typed chips navigate.
- [ ] **Step 4: Commit** — `feat(web): app-wide Ask panel — store-driven, typed source chips, global launcher`

---

### Task 10: Calendar `?event=<id>` deep link (web)

**Files:**
- Modify: `apps/web/app/(app)/calendar/page.tsx` (CalendarPage effects region — follow the existing `?createFromEmail` consumer's pattern, and the docs `?open=` consume-once idiom: ref guard + `router.replace('/calendar')`)

**Interfaces:**
- Consumes: `events` state + `setSelectedEvent` in CalendarPage; Task 9's `sourceHref` produces these URLs.
- Produces: visiting `/calendar?event=<id>` selects that event (opening EventDetailPanel) once events for the current range have loaded; unknown id fails quietly (no crash, param still cleaned). If the event isn't in the loaded range, fall back to `api.calendar.getEvent(id)` and select the fetched event; 404 → quiet console.warn.

- [ ] **Step 1: Implement** (read `window.location.search` in an effect gated on events-loaded, consume-once ref, `router.replace`).
- [ ] **Step 2: Verify** — tsc + full vitest green (page-level wiring; no new unit test mandated). Manual: controller's browser sweep.
- [ ] **Step 3: Commit** — `feat(calendar): ?event=<id> deep link opens the event detail panel`

---

### Task 11: "Ask this document" entry (web)

**Files:**
- Modify: `apps/web/components/docs/DocsEditor.tsx` (toolbar button)
- Modify: `apps/web/app/(app)/docs/page.tsx` ONLY if the doc title isn't available to the editor as a prop (check `DocsEditor`'s props — the page holds the active doc's title)

**Interfaces:**
- Consumes: `useAskStore.openAsk({ scope: { docId, docTitle } })` (Task 8); the panel's scope chip behavior (Task 9).
- Produces: an Ask button (`MessageCircleQuestion`, `text-ui` sizing matching its toolbar siblings, `aiEnabled`-gated, absent on the anonymous share route — check how the share page renders the editor: `app/docs/share/[token]/page.tsx` passes different props; gate on whatever already distinguishes authenticated use, e.g. the presence of `collaborationToken` type 'jwt' or an explicit new `canAsk` prop defaulting to false on the share route) that opens the panel scoped to the current doc.

- [ ] **Step 1: Wire it** — button in the DocsEditor top toolbar near the TOC/panel toggles; on click `openAsk({ scope: { docId, docTitle } })`.
- [ ] **Step 2: Verify** — tsc + full vitest green; manual (controller): button opens the panel with the `This document` chip; asking answers from that doc only; removing the chip widens the same conversation; the button is absent on a share-token page.
- [ ] **Step 3: Commit** — `feat(docs): Ask-this-document — scoped entry into the app-wide Ask panel`

---

## Final verification (after Task 11)

- [ ] `cd apps/web && npx tsc --noEmit && npx vitest run` — green (target ≥ 385).
- [ ] `cd apps/api && npx tsc --noEmit && npx jest` — green.
- [ ] Containerized build: `scripts/build-web-154.sh` AND `scripts/build-api.sh` (api changed this phase — remember its in-bundle `prisma generate` is mandatory).
- [ ] Push `ft-hyperscale`.
- [ ] Deploy note for the controller: this phase needs `prisma migrate deploy` on both VMs before the new api starts (first migration since phase 4; .155 goes through Bruce's `!` script route).
- [ ] Manual sweep (controller, in-browser on .154): doc gets embedded within ~a minute of an edit (worker log line); Ask from the tasks page FAB answers a mail question; a docs question cites a `FileText` chip that opens the doc; a calendar question ("what do I have with X next week") cites an event chip that opens the event; Ask-this-document scope chip narrows then widens; revoking an invite removes the doc from a repeat ask; injection banner still renders for a suspicious mail source. No test events with real attendees; nothing sent.
