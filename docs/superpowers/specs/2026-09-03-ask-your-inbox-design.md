# Ask Your Inbox — Design

**Date:** 2026-09-03
**Status:** Approved design, pending implementation plan
**Phase:** 4 of the inbox-intelligence roadmap (final phase; builds on phase 2's persisted cards and the phase 1–3 worker/streaming/citation patterns)
**Review page:** https://claude.ai/code/artifact/e7e76700-9c02-4cac-b322-dc9089e4ac99

## Purpose

A chat surface where the user asks questions of their own mailbox in plain language — English, French, or Kinyarwanda — and gets a streamed, citation-backed answer generated entirely on-premises. Retrieval is hybrid: pgvector embeddings over a rolling 90-day corpus fused with Zimbra keyword search. A semantic mode in ⌘K search falls out of the same retrieval layer. Per the vendor benchmark (`docs/research/2026-09-03-ai-email-clients-benchmark.md`), no commercial AI mail client offers self-hosted chat-with-inbox — this is the differentiator feature.

## Decisions (settled with the user)

- **Chat-first; search as byproduct:** the deliverable is the ask-your-inbox panel; retrieval is built to serve it, and a semantic section in ⌘K reuses the same layer. One design, one plan (the docs' undefined "4a/4b" split collapses into this).
- **Hybrid retrieval:** pgvector vector search + Zimbra keyword search, fused with Reciprocal Rank Fusion. Chosen over embeddings-only (misses exact terms) and no-embeddings (weak paraphrase/cross-language recall).
- **Corpus = 90 days, Inbox + Sent:** matches the existing card retention; widenable later by config.
- **Read-only + safe deep-links:** chat answers questions and cites sources; it can offer buttons that open existing UIs pre-filled (open message, pre-filled reply). It executes nothing. Actions stay in existing human-reviewed flows.
- **Embedding model = bge-m3** (1024 dims, ~2.2 GB): genuinely multilingual — the right default for a gov mailbox that is not English-only. Must be shipped to the offline Ollama host like the qwen models were.
- **Server-side generation:** unlike phases 1–3 (browser-driven), retrieval needs the DB and Zimbra, so the API owns the whole pipeline and picks the model via `CHAT_MODEL` env — not the browser's ai.store model.

## Architecture

Three new pieces, each cloned from a proven phase 1–3 pattern: an embedding worker beside `CardWorkerService`, a retrieval + chat service in a new `chat` module, and a web drawer panel mirroring `CommitmentsPanel`.

### 1. Data — pgvector + `MessageEmbedding`

One migration enables the extension and creates the table. Prisma 7 has no native vector type: the column is `Unsupported("vector(1024)")` and similarity queries go through `$queryRaw` (precedent: `contacts.service.ts`; identifiers double-quoted camelCase).

```prisma
model MessageEmbedding {
  id          String                       @id @default(cuid())
  messageId   String
  userId      String
  chunkIndex  Int                          // 0-based; <= 4 chunks per message
  model       String                       // embed-model tag; model change => re-embed
  chunkText   String                       // the embedded text — prompt context + snippet
  embedding   Unsupported("vector(1024)")? // null on tombstone rows
  failed      Boolean  @default(false)     // tombstone — invisible to reads
  extractedAt DateTime @default(now())

  message Message @relation(fields: [messageId], references: [id], onDelete: Cascade)

  @@unique([messageId, chunkIndex, model])
  @@index([userId, extractedAt])
  @@map("message_embeddings")
}
```

- Raw-SQL HNSW index (`vector_cosine_ops`) in the same migration. At this scale (a few thousand rows per user's 90-day window) a filtered HNSW scan is comfortable.
- **Infrastructure change:** compose Postgres image moves `postgres:17-alpine` → `pgvector/pgvector:pg17` (same PG major; existing `pgdata` volume attaches unchanged). On natively-installed VMs the pgvector package for PG 17 must be installed **before** `prisma migrate deploy`, or `CREATE EXTENSION vector` fails and wedges migration history (same hazard class as the sender-rules migration).
- **Chunking:** shared `chunkForEmbedding()` splits `extractEmailText` output (quoted-history + signature stripping, EN/FR/Kinyarwanda markers) on paragraph boundaries into ≤ 1,500-char chunks, max 4 per message, subject line prefixed to chunk 0. Storage ≈ 4 KB/vector, ≤ 16 KB + text per message.

### 2. Embedding worker (`EmbedWorkerService`, mail module)

Copies the `CardWorkerService` skeleton:

- **Selection:** `receivedAt >= now()-90d`, folder `/Inbox`/`/Sent`, user has a live Zimbra token, no non-failed embedding rows for the current `EMBED_MODEL`. Newest first — recent mail searchable immediately, history backfills behind it.
- **Fairness:** reuse the exported `pickFairBatch`; separate pacing envs (embedding is cheap and batchable): default 16/tick, 4/user/tick. Backfill throughput ≈ 23k messages/day — a typical 90-day backfill completes within the first day.
- **Hydration:** `MailService.getMessage()` (cache-first, same as cards).
- **Embedding call:** new `EmbedderService` mirroring `CardExtractorService` — raw fetch to Ollama's native `/api/embed`, batched input array (one HTTP call per message's chunks). `OLLAMA_BASE_URL` shared, `EMBED_MODEL` default `bge-m3:latest`.
- **Failure handling:** identical 3-strike in-memory counter → tombstone row (`failed: true`, null vector); counters reset on restart by design.
- **Purge:** in the same hourly throttled purge pass — delete embeddings whose message left the 90-day window; superseded-model rows purge lazily as re-embeds land.

### 3. Retrieval (`RetrievalService`, new `chat` module)

Two legs run concurrently:

- **Vector leg:** embed the question with bge-m3, cosine top-20 chunks over the user's rows via `$queryRaw`, best chunk per message.
- **Keyword leg:** deterministic keyword extraction (EN/FR/Kinyarwanda stopword strip, quoted phrases preserved) → existing `ZimbraService.searchMessages`, limit 10, scoped to 90 days. No LLM query-rewrite in v1 — deterministic is testable and free; rewrite is a noted future upgrade.
- **Fusion:** RRF (`score = Σ 1/(60 + rank)`), dedupe by message, take top 8. RRF chosen precisely because it needs no score calibration between legs.
- **Source context:** per source — subject, sender, date, plus ≤ 1,200 chars: matching `chunkText` for vector hits; for keyword-only hits, `extractEmailText` over the cached body if present, else the Zimbra snippet. At most 3 uncached hydrations per question to bound latency.
- **Degradation:** one leg failing degrades to the other with a notice flag; both failing or zero sources short-circuits to a canned "couldn't find anything relevant" — the model is never asked to answer without sources (cheapest hallucination guard).
- **Search byproduct:** `GET /mail/search/semantic?q=` exposes the vector leg alone in message-list shape; ⌘K gains a "From your mail (semantic)" section and an "Ask your inbox…" row that opens the panel pre-filled.

### 4. Chat pipeline (`POST /ai/inbox-chat`)

- Controller in the `chat` module: `JwtAuthGuard`, throttled 20/min (stricter than the general AI proxy's 120/min).
- Request: the conversation's last ≤ 6 turns. Retrieval runs on the latest user turn; earlier turns clamped and included for continuity. **No server-side conversation persistence** — state lives in the panel (YAGNI).
- SSE protocol: first a `sources` event carrying `[{alias, messageId, subject, from, receivedAt, injectionSuspected}]`, then OpenAI-style token deltas (existing web SSE parser handles these unchanged), then `[DONE]`. Client disconnect aborts the upstream Ollama call.
- Prompt assembly in `packages/shared/src/ai/chat.ts` (testable from both apps, like `cards.ts`): system prompt with `UNTRUSTED_CONTENT_RULE`, a **named-language** instruction (answer in the question's language — phase 1 lesson: small models ignore "same language as the email"), each source passed through `neutralizeMarkers` + `fenceUntrusted` and labeled `s1…sN`, instruction to cite aliases inline.
- Generation: `CHAT_MODEL`, default `qwen3-30b-16k:latest` (reserved for chat since phase 2). Failure mapping mirrors `ai.service.ts` (`BadGatewayException` / `ServiceUnavailableException`).

## Threat model

Phase 1 measured that sentinel fencing does **not** reliably stop prompt injection on small local models. Phases 1–3 were safe because AI output only ever landed in a human-reviewed draft. A chat answer is read and believed directly, so phase 4's protection is **capability containment**, not prompt hygiene:

- **Read-only:** the endpoint takes no write action. A fully steered model can at worst emit misleading text.
- **Citations as verification:** every claim carries an `s{i}` chip; one click shows the actual email. The UI states answers are AI-generated and should be checked against sources.
- **Aliases as a security boundary:** the model only ever names `s1…sN`. Deep-links are constructed client-side from the `sources` event (server-supplied, validated data) — no id, URL, or route parameter in model output is ever dereferenced. A hallucinated or injected citation resolves to nothing. This mapping gets an explicit test.
- **Deep-links are inert:** chips open the message view or a pre-filled compose/reply — flows that already require full human review to act.
- **Injection banner:** if any retrieved source has `MessageCard.injectionSuspected` set (or shared `detectInjectionAttempt` fires on its chunk), the panel shows the existing warning treatment and flags the offending source chip. Suspected sources stay **in** retrieval — silently dropping mail would make answers wrong in a different way.
- **Output scrubbing:** answers pass through the existing `scrubOutput` before final render.

## Web UI

- **`AskInboxPanel`** — right-side drawer over the mail view, same shell/z-order conventions as `CommitmentsPanel` (`z-[41]`), opened from a toolbar button beside Briefing/Commitments and from the ⌘K row. Multi-turn within the session; conversation clears on logout like the briefing cache.
- **Streaming answer** via `useCharStream`; `[s1]`-style citations swapped for chips post-scrub. Chips show sender + subject on hover; click opens the message.
- **Sources rail** under each answer listing all retrieved sources, cited or not — the user sees what the model saw.
- **Deep-link affordances** per source: Open message · Reply (pre-filled compose) · linked commitment when one matches the message.
- **States:** AI-disabled empty state; retrieval-degraded notice; zero-sources canned reply; 429 with the existing backoff treatment.

## Configuration & deployment

| Env var | Default | Notes |
|---|---|---|
| `EMBED_MODEL` | `bge-m3:latest` | new; tag stored per row |
| `CHAT_MODEL` | `qwen3-30b-16k:latest` | new; server-side choice |
| `EMBED_BATCH_PER_TICK` / `EMBED_PER_USER_PER_TICK` | 16 / 4 | new; worker pacing |
| `OLLAMA_BASE_URL`, `CARD_MODEL` | — | existing but absent from every env template and compose file — fixed as part of this phase |

Pre-deploy checklist (VM):

1. Ship `bge-m3` to the Ollama host (192.168.100.2); verify with a one-line `/api/embed` smoke call.
2. Extend `scripts/card-model-spotcheck.mjs` with an embedding spot-check (retrieval quality over real EN/FR/Kinyarwanda questions) — run on the VM before enabling the panel.
3. Install pgvector for the target Postgres (compose: image swap; native: distro package) **before** `prisma migrate deploy`.
4. `prisma migrate deploy` (extension + `message_embeddings` + HNSW index).
5. Add the new env vars to `/opt/govmail/api.env` and the compose `x-api-env` anchor.

**Standalone desktop variant:** runs SQLite, which cannot host pgvector. Phase 4 features are gated on a Postgres datasource — the worker doesn't start and the panel/endpoints are hidden. No keyword-only fallback in v1.

## Testing

- **Shared:** `chunkForEmbedding` (boundaries, subject prefix, max-chunk cap); chat prompt builder (fencing applied to every source, language rule named, alias format); citation-parsing regex.
- **API:** worker selection query shape + fairness (reusing card-worker test patterns); tombstone behavior; RRF fusion unit tests (mocked legs, dedupe, degradation paths); SSE controller test (sources event precedes deltas; abort propagates); zero-sources short-circuit.
- **Web:** panel state machine; the alias→deep-link mapper (security-relevant: an alias not in the sources event must resolve to nothing).
- **Contract seam:** the web `request()` helper's quirks (rejects empty bodies) bit phase 3 — the chat endpoint gets an explicit API-client contract test rather than mocks agreeing by luck.
- **Manual E2E on the VM:** French question over French mail; Kinyarwanda question; exact-term lookup (invoice number — keyword leg); paraphrase lookup (vector leg); an injection-bearing email in the retrieval set.

## Out of scope

Conversation persistence/history; any write action from chat; full-mailbox-history embedding (window is config-widenable later); attachment content extraction; LLM query-rewrite for the keyword leg; user-facing chat model selection; folders beyond Inbox/Sent; admin retrieval-quality dashboards; the SQLite desktop variant.
