# Deeper Retrieval — AI Phase 4b retrieval-quality stream

**Date:** 2026-09-08 · **Status:** approved (design page: https://claude.ai/code/artifact/74f95a10-59f4-4e9a-9b07-04589c083272)
**Scope:** three retrieval-quality upgrades shipped as one stream: (1) attachment-content search,
(2) server-side source dedup with stable aliases, (3) doc-scoped ask depth.
**Out of scope:** OCR/image attachments, docs-module file uploads, always-allow, ask/agent
unification, streaming-jank profiling, ToolContext AbortSignal, audit proposal-vs-execution column.
The signature-CID + quick-wins batch is a separate bounded stream with no spec.

## 1. Attachment-content search

**Problem.** `read_attachment` can read a file the model already located, but no retrieval leg sees
attachment text — "find the contract that mentions X" fails when X only appears inside a PDF.

### 1.1 Data model

New table `attachment_embeddings` mirroring `message_embeddings` (schema.prisma:204):

```prisma
model AttachmentEmbedding {
  id          String   @id @default(cuid())
  messageId   String
  userId      String
  partId      String                        // Zimbra MIME part id
  filename    String
  mimeType    String
  chunkIndex  Int                           // 0-based; <= 6 chunks per attachment
  model       String                        // embed-model tag; model change => re-extract
  chunkText   String                        // embedded text — prompt context + snippet
  embedding   Unsupported("vector(1024)")?  // null on tombstone rows; written via $executeRaw
  failed      Boolean  @default(false)      // tombstone: extraction/embedding gave up
  extractedAt DateTime @default(now())

  message Message @relation(fields: [messageId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([messageId, partId, chunkIndex, model])
  @@index([userId, extractedAt])
  @@map("attachment_embeddings")
}
```

Migration `add_attachment_embeddings` is **hand-authored** (HNSW cosine index on `embedding`;
Prisma drift detection must never drop it — same rule as message/document embeddings). Dev DB uses
`db execute` + `migrate resolve --applied` per the established drifted-dev-DB workflow.

### 1.2 Extraction helper (shared)

Hoist the extractors out of `agent/tools/attachment-text.ts` into a shared api helper (e.g.
`apps/api/src/common/attachment-text.ts` or a mail-module service) so the agent tool and the worker
call **one implementation**. Supported: PDF (pdf-parse, pinned exact 1.1.1 — v2 is a breaking
rewrite), DOCX (mammoth), text/plain-ish. Cap 10 MB per file (same as read_attachment). No OCR.

### 1.3 Worker

`AttachmentEmbedWorkerService` — 5th cron skeleton, same shape as `DocEmbedWorkerService`:

- Candidate selection **in SQL**: messages in folders with path `/Inbox` or `/Sent`, having
  eligible attachment parts, `receivedAt >= now() - ATTACH_BACKFILL_DAYS`, with
  `NOT EXISTS (attachment_embeddings for messageId+partId with current model)`. (The
  take-before-filter starvation bug from phase 3a must not be reintroduced.)
- Users with `authToken` set and `tokenExpiry > now()` only (downloads need the stored Zimbra token,
  via `zimbra.downloadAttachmentBuffer`).
- Budget env vars: `ATTACH_EMBED_PER_TICK=3` (attachments per tick), per-user cap 2 per tick,
  `ATTACH_BACKFILL_DAYS=90` (aligned with the infra-plan retention decision). Deliberately lower
  than the message worker — the constraint is Zimbra download bandwidth, not GPU (bge-m3 measured
  31 ms/chunk batched; ~6 chunks/attachment max; storage ~14 KB/chunk).
- Messages are immutable → no staleness/re-embed trigger; a changed `EMBED_MODEL` tag re-extracts.
- Extraction or embedding failure writes a **tombstone** row (`failed: true`, null embedding) —
  invisible to reads, never retried unless the model tag changes. Same contract as message embeddings.
- If/when the sharing stream lands its `Message.isShared` flag, the candidate query excludes it
  (today mountpoint paths are already excluded by the `/Inbox`+`/Sent` filter).

### 1.4 Retrieval leg

- Fifth leg in `RetrievalService.retrieve` (retrieval.service.ts), gated with the mail legs
  (`scope.types` includes `mail`); shares the single question-embedding promise like the other
  vector legs; failure sets a new `degraded.attachment` flag (additive to the degraded shape).
- Leg rows: top attachment chunks by cosine distance for the user (ACL = `userId` equality, same as
  mail). **Key = `mail:<messageId>`** — the parent message's key — so `rrfFuse` merges an
  attachment hit with a body hit on the same message into one source.
- Context blocks are labeled `[from attachment "filename.pdf"]`; the citation chip stays type
  `mail` and deep-links to the message as usual.

### 1.5 Agent tool

One new read tool `search_attachments(query)` (tool count 20 → 21) in the registry:

- Semantic search over the user's attachment chunks; returns message refs (standard `(id …)`
  exposure so `read_email`/`read_attachment` chain off it) + filename + snippet.
- Description teaches: use when the user asks about the *contents of files*; never invent ids.
- Schema rule: no regex `pattern` keys may reach the advertised schema (llama.cpp grammar
  limitation, established rule).

## 2. Server-side source dedup

**Problem.** `nextAlias()` is a bare counter (`agent.service.ts:59-63`) — every tool result mints
fresh aliases, so the same message cited across three searches becomes three source cards (live
testing: 35 cards, mostly dupes) and the model treats one message as three documents.

- `ToolContext` replaces `nextAlias()` with `aliasFor(type, id)` backed by an
  `aliasByKey: Map<'type:id', alias>` scoped to the **turn** (chips resolve against per-answer
  source maps, so cross-turn seeding is unnecessary). A ref whose `type:id` is already mapped
  returns the existing alias; only unseen keys mint a new one.
- Refs still travel on every `tool_result` frame (the model needs the rendered lines), but the
  panel's source accumulator drops aliases it has already collected (upgrading the injection flag
  on a flagged repeat) — the sources rail gets exactly one card per underlying item, and repeated
  tool results render the same `[sN]` in the prompt.
- The alias-rejection dispatch guard, chip sanitizers, and the citation whitelist are untouched —
  aliases simply become stable. No web changes required beyond what already renders.

## 3. Doc-scoped ask depth

**Problem.** The docs leg keeps only the best chunk per document (`seen.has(r.documentId)`,
retrieval.service.ts:230) — right for cross-doc ranking, but "Ask this document" answers from a
single ~1200-char excerpt.

- When `scope.docId` is set: skip the per-document dedupe and take the **top 6 chunks**
  (distance-ordered) of that document, joined into **one deep context block** under **one** source
  chip (the per-source context clamp is raised for this hit only; cross-doc hits keep the 1200-char
  clamp). Single-doc scope runs only the docs leg, so fusion order is unaffected.
- Cross-doc behavior unchanged. Meeting-prep and dossier call `retrieve` without `docId` — unaffected.

## 4. Testing

- **jest (api):** worker candidate-selection SQL (staleness, budgets, per-user cap, tombstones,
  backfill window); extractor-reuse parity (tool and worker produce identical text for a fixture
  PDF/DOCX); retrieval-leg fusion (attachment hit + body hit on same message → one fused source);
  degraded.attachment flag; alias stability across repeated tool results; SSE first-sighting-only
  source emission; docId depth (6 chunks, one source; dedupe intact without docId);
  `search_attachments` tool (schema pattern-free, ref exposure).
- **vitest (web):** rail renders one card per source on a repeated-search transcript; attachment-
  labeled snippet display.
- **Live sweep (.154):** the RHEMIS PDF case — a term that only appears inside the PDF is found via
  `search_attachments` and answered with citation; rail card count on a repeated-search
  conversation (before: duplicates, after: one per item); Ask-this-document on a long doc gives a
  multi-section answer.
- **Rollout:** standard container build + tarball deploy to both VMs; migration applied on both
  (embedded PG 5433 on .155); worker observable via tick logs like the other three workers.

## 5. Execution notes

- Subagent-driven development directly on `ft-hyperscale` (no worktree — standing preference).
- Both containerized builds must pass before deploy; prisma-client tarball guard count is 17
  (Prisma 7.4.1 layout).
- Never save test events with real attendees on the VMs.
