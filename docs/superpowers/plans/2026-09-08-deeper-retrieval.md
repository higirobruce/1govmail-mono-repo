# Deeper Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attachment-content search (ingest + retrieval leg + agent tool), stable de-duplicated citation aliases, and full-depth doc-scoped asks.

**Architecture:** A new `attachment_embeddings` table mirrors `message_embeddings`; a 5th cron worker extracts (pdf-parse/mammoth) and embeds attachment text; `RetrievalService` gains an attachment vector leg keyed on the *parent message* so it fuses with body hits, plus a `searchAttachments` method backing a new `search_attachments` agent tool. `ToolContext.nextAlias()` becomes `aliasFor(type,id)` (turn-scoped stable aliases) and the AskPanel accumulator dedupes by alias. Doc-scoped asks join the top 6 chunks of the target doc into one deep context block.

**Tech Stack:** NestJS 11, Prisma 7 (PostgreSQL + pgvector HNSW), zod, jest (api), vitest (web), qwen3 via Ollama, bge-m3 embeddings.

**Spec:** `docs/superpowers/specs/2026-09-08-deeper-retrieval-design.md`

## Global Constraints

- pdf-parse stays pinned EXACT `1.1.1` — v2 is a breaking rewrite. Never `pnpm add pdf-parse@latest`.
- No regex `pattern` keys may reach an advertised tool schema (llama.cpp grammar limitation); `stripPatterns` handles zod output but never add a `.regex()`/`.email()` needing it to matter.
- Migrations are **hand-authored** on this repo (permanent dev-DB drift from HNSW indices): write SQL by hand, apply with `npx prisma db execute`, record with `npx prisma migrate resolve --applied`.
- Never let Prisma drift-detection drop an HNSW index.
- Untrusted content (subjects, filenames, chunk text) must never be interpolated into thrown/returned error strings in agent dispatch paths — static text only.
- Env defaults: `ATTACH_EMBED_PER_TICK=3`, `ATTACH_EMBED_PER_USER_PER_TICK=2`, `ATTACH_BACKFILL_DAYS=90`; max 6 chunks per attachment; 10 MB per-file cap (`MAX_ATTACHMENT_BYTES`).
- Run api tests from `apps/api` (`npx jest <path>`), web tests from `apps/web` (`npx vitest run <path>`).
- Commit after every task; work directly on `ft-hyperscale`.

---

### Task 1: Hoist the attachment extractor to `common/`

The worker (Task 3) and the agent tool must share one extractor. Today it lives in `apps/api/src/agent/attachment-text.ts`.

**Files:**
- Move: `apps/api/src/agent/attachment-text.ts` → `apps/api/src/common/attachment-text.ts` (content unchanged)
- Modify: every importer (find with grep; known: `apps/api/src/agent/tools/attachment.tools.ts`)

**Interfaces:**
- Produces (unchanged, new path `../../common/attachment-text` from `agent/tools/`, `../common/attachment-text` from `mail/`):
  - `MAX_ATTACHMENT_BYTES: number` (10 MB)
  - `streamToBuffer(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer>`
  - `extractAttachmentText(buf: Buffer, mimeType: string, filename: string): Promise<string>`

- [ ] **Step 1: Move the file**

```bash
cd /Users/brucehigiro/Documents/development/email-client
git mv apps/api/src/agent/attachment-text.ts apps/api/src/common/attachment-text.ts
```

- [ ] **Step 2: Update importers**

```bash
grep -rn "attachment-text" apps/api/src --include="*.ts"
```

For each hit (expected: `agent/tools/attachment.tools.ts`, possibly a spec), change the import path, e.g. in `attachment.tools.ts`:

```ts
import { extractAttachmentText, streamToBuffer, MAX_ATTACHMENT_BYTES } from '../../common/attachment-text';
```

- [ ] **Step 3: Verify compilation and tests**

Run from `apps/api`: `npx tsc --noEmit && npx jest src/agent`
Expected: PASS (no behavior change).

- [ ] **Step 4: Commit**

```bash
git add -A apps/api/src && git commit -m "refactor(api): hoist attachment text extraction to common/ for worker reuse"
```

---

### Task 2: `attachment_embeddings` model + hand-authored migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (new model + back-relations on `Message` and `User`)
- Create: `apps/api/prisma/migrations/<timestamp>_add_attachment_embeddings/migration.sql`

**Interfaces:**
- Produces: Prisma model `AttachmentEmbedding` (client accessor `prisma.attachmentEmbedding`), table `"attachment_embeddings"`.

- [ ] **Step 1: Add the model to schema.prisma** (place after `DocumentEmbedding`)

```prisma
model AttachmentEmbedding {
  id          String   @id @default(cuid())
  messageId   String
  userId      String
  partId      String                        // Zimbra MIME part id ("!" on tombstone rows)
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

Add to `model Message`: `attachmentEmbeddings AttachmentEmbedding[]`
Add to `model User`: `attachmentEmbeddings AttachmentEmbedding[]`

- [ ] **Step 2: Create the migration directory and SQL by hand**

Directory name: `$(date -u +%Y%m%d%H%M%S)_add_attachment_embeddings` under `apps/api/prisma/migrations/`.

```sql
-- attachment_embeddings: chunked embedded text extracted from mail attachments.
-- Hand-authored: prisma migrate dev cannot run against this drifted dev DB, and
-- the HNSW index below must never be dropped by drift detection.
CREATE TABLE "attachment_embeddings" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "chunkText" TEXT NOT NULL,
    "embedding" vector(1024),
    "failed" BOOLEAN NOT NULL DEFAULT false,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "attachment_embeddings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "attachment_embeddings_messageId_partId_chunkIndex_model_key"
    ON "attachment_embeddings"("messageId", "partId", "chunkIndex", "model");
CREATE INDEX "attachment_embeddings_userId_extractedAt_idx"
    ON "attachment_embeddings"("userId", "extractedAt");
CREATE INDEX "attachment_embeddings_embedding_hnsw"
    ON "attachment_embeddings" USING hnsw ("embedding" vector_cosine_ops);

ALTER TABLE "attachment_embeddings"
    ADD CONSTRAINT "attachment_embeddings_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attachment_embeddings"
    ADD CONSTRAINT "attachment_embeddings_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Apply + record + regenerate** (from `apps/api`)

```bash
npx prisma db execute --file prisma/migrations/<dir>/migration.sql
npx prisma migrate resolve --applied <dir>
npx prisma generate
```

Expected: all three succeed; `npx prisma migrate status` shows no pending migrations.

- [ ] **Step 4: Smoke-check the table**

Run from `apps/api`: `node -e "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.attachmentEmbedding.count().then(c=>{console.log('rows',c);process.exit(0)})"`
Expected: `rows 0`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma && git commit -m "feat(db): attachment_embeddings table with HNSW index (hand-authored migration)"
```

---

### Task 3: `AttachmentEmbedWorkerService`

**Files:**
- Create: `apps/api/src/mail/attachment-embed-worker.service.ts`
- Modify: `apps/api/src/mail/mail.module.ts` (add to `providers`)
- Test: `apps/api/src/mail/attachment-embed-worker.service.spec.ts`

**Interfaces:**
- Consumes: `MailService.getMessage(userId, messageId)` (hydrates `Message.attachments`), `MailService.downloadAttachment(userId, messageId, part)` → `{ stream, contentType, filename }`; `EmbedderService.embed(texts: string[]): Promise<number[][]>` and `.model: string`; `chunkPlainText(text, headerLine, maxChunks)` from `@email-client/shared`; `extractAttachmentText`/`streamToBuffer`/`MAX_ATTACHMENT_BYTES` from `../common/attachment-text`; `pickFairBatch` from `./card-worker.service`.
- Produces: cron worker (minute tick), `processTick(): Promise<{ embedded: number; tombstoned: number; skipped: number }>` — counts are messages, not parts.

**Key behaviors** (all asserted by tests below):
1. Candidate selection entirely in SQL: `hasAttachments`, folder path `/Inbox`/`/Sent`, `receivedAt` within `ATTACH_BACKFILL_DAYS`, live user token, `NOT EXISTS` any `attachment_embeddings` row for (messageId, current model). LIMIT bounds *work*, not eligibility (the phase-3a starvation rule).
2. `Message.attachments` is `[]` until `getMessage` hydration — the worker hydrates via `mailService.getMessage` when the cached array is empty, then re-reads.
3. Eligible parts: PDF / DOCX / text by mime or filename (mirror `extractAttachmentText` support), `size` absent-or-≤ 10 MB. Per-part failures are caught and skipped; a message ending with **zero** rows gets a tombstone (partId `"!"`, chunkIndex 0, failed true). A message whose Zimbra calls fail gets the 3-strike in-memory failure counter (same as the doc worker) before tombstoning.
4. Inserts replace: one transaction — `deleteMany({ where: { messageId } })` then raw INSERTs with `${vec}::vector`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/mail/attachment-embed-worker.service.spec.ts
import { AttachmentEmbedWorkerService } from './attachment-embed-worker.service';
import { Readable } from 'node:stream';

const pdfPart = { id: '2', filename: 'report.txt', mimeType: 'text/plain', size: 1000 };

function makeService(overrides: {
  candidates?: any[];
  attachments?: any[];
  downloadText?: string;
} = {}) {
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue(overrides.candidates ?? []),
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn().mockResolvedValue([]),
    message: {
      findUnique: jest.fn().mockResolvedValue({ attachments: overrides.attachments ?? [pdfPart] }),
    },
    attachmentEmbedding: {
      deleteMany: jest.fn().mockReturnValue({}),
      create: jest.fn().mockReturnValue({}),
    },
  };
  const embedder: any = { model: 'bge-m3:latest', embed: jest.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])) };
  const mail: any = {
    getMessage: jest.fn().mockResolvedValue({}),
    downloadAttachment: jest.fn().mockResolvedValue({
      stream: Readable.from([Buffer.from(overrides.downloadText ?? 'quarterly totals: 42')]),
      contentType: 'text/plain',
      filename: 'report.txt',
    }),
  };
  return { svc: new AttachmentEmbedWorkerService(prisma, embedder, mail), prisma, embedder, mail };
}

const cand = { id: 'm1', userId: 'u1' };

describe('AttachmentEmbedWorkerService', () => {
  it('embeds eligible parts and reports one embedded message', async () => {
    const { svc, prisma, embedder } = makeService({ candidates: [cand] });
    const res = await svc.processTick();
    expect(res.embedded).toBe(1);
    expect(embedder.embed).toHaveBeenCalled();          // chunks were embedded
    expect(prisma.$transaction).toHaveBeenCalled();      // delete+insert transaction ran
  });

  it('hydrates via getMessage when the cached attachments array is empty', async () => {
    const { svc, prisma, mail } = makeService({ candidates: [cand] });
    prisma.message.findUnique
      .mockResolvedValueOnce({ attachments: [] })        // pre-hydration read
      .mockResolvedValueOnce({ attachments: [pdfPart] }); // post-hydration read
    await svc.processTick();
    expect(mail.getMessage).toHaveBeenCalledWith('u1', 'm1');
  });

  it('tombstones a message with no eligible parts', async () => {
    const { svc, prisma } = makeService({
      candidates: [cand],
      attachments: [{ id: '2', filename: 'photo.png', mimeType: 'image/png', size: 500 }],
    });
    const res = await svc.processTick();
    expect(res.tombstoned).toBe(1);
    expect(prisma.attachmentEmbedding.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ partId: '!', failed: true }) }),
    );
  });

  it('skips (not tombstones) on transient failure until the 3rd strike', async () => {
    const { svc, mail } = makeService({ candidates: [cand] });
    mail.downloadAttachment.mockRejectedValue(new Error('zimbra down'));
    expect((await svc.processTick()).skipped).toBe(1);
    expect((await svc.processTick()).skipped).toBe(1);
    expect((await svc.processTick()).tombstoned).toBe(1); // 3rd strike
  });

  it('caps chunks per attachment at 6', async () => {
    const { svc, embedder } = makeService({ candidates: [cand], downloadText: 'x'.repeat(100_000) });
    await svc.processTick();
    const chunks = embedder.embed.mock.calls[0][0];
    expect(chunks.length).toBeLessThanOrEqual(6);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `apps/api`: `npx jest src/mail/attachment-embed-worker.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the worker**

```ts
// apps/api/src/mail/attachment-embed-worker.service.ts
import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { chunkPlainText } from '@email-client/shared';
import { PrismaService } from '../prisma/prisma.service';
import { EmbedderService } from './embedder.service';
import { MailService } from './mail.service';
import { pickFairBatch } from './card-worker.service';
import { extractAttachmentText, streamToBuffer, MAX_ATTACHMENT_BYTES } from '../common/attachment-text';

const ATTACH_EMBED_PER_TICK = Number(process.env.ATTACH_EMBED_PER_TICK ?? 3);
const ATTACH_EMBED_PER_USER_PER_TICK = Number(process.env.ATTACH_EMBED_PER_USER_PER_TICK ?? 2);
const ATTACH_BACKFILL_DAYS = Number(process.env.ATTACH_BACKFILL_DAYS ?? 90);
const MAX_CHUNKS_PER_ATTACHMENT = 6;
/** partId of the per-message tombstone row (a real Zimbra part id is numeric-ish, never "!"). */
export const TOMBSTONE_PART = '!';

interface AttachmentCandidate { id: string; userId: string }
interface AttachmentPart { id: string; filename?: string; mimeType?: string; size?: number }

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TEXT_TYPES = /^(text\/|application\/(json|xml|csv))/;

/** Mirrors extractAttachmentText support — anything this rejects would throw there. */
export function eligiblePart(a: AttachmentPart): boolean {
  if ((a.size ?? 0) > MAX_ATTACHMENT_BYTES) return false;
  const mime = a.mimeType ?? '';
  const lower = (a.filename ?? '').toLowerCase();
  return (
    mime === 'application/pdf' || lower.endsWith('.pdf') ||
    mime === DOCX_MIME || lower.endsWith('.docx') ||
    TEXT_TYPES.test(mime) || /\.(txt|csv|md|log)$/.test(lower)
  );
}

/**
 * Attachment embedding worker — 5th cron skeleton, sibling of the doc/mail
 * embed workers. Unit of work = one MESSAGE (all its eligible parts): once any
 * row (real or tombstone) exists for (messageId, model), the NOT EXISTS stops
 * selecting it, so eligibility lives in SQL and LIMIT bounds work only.
 * Deliberately low budget: each part is a Zimbra download.
 */
@Injectable()
export class AttachmentEmbedWorkerService {
  private readonly logger = new Logger(AttachmentEmbedWorkerService.name);
  private failures = new Map<string, number>();
  private readonly FAILURE_LIMIT = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedder: EmbedderService,
    private readonly mail: MailService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { waitForCompletion: true })
  async tick() {
    try {
      await this.processTick();
    } catch (err: any) {
      this.logger.error(`processTick failed: ${err?.message}`);
    }
  }

  async processTick(): Promise<{ embedded: number; tombstoned: number; skipped: number }> {
    const model = this.embedder.model;
    const candidates = await this.prisma.$queryRaw<AttachmentCandidate[]>`
      SELECT m."id", m."userId"
      FROM "messages" m
      JOIN "users" u ON u."id" = m."userId"
      JOIN "folders" f ON f."id" = m."folderId"
      WHERE m."hasAttachments" = true
        AND f."path" IN ('/Inbox', '/Sent')
        AND m."receivedAt" >= NOW() - make_interval(days => ${ATTACH_BACKFILL_DAYS})
        AND u."authToken" IS NOT NULL AND u."tokenExpiry" > NOW()
        AND NOT EXISTS (
          SELECT 1 FROM "attachment_embeddings" e
          WHERE e."messageId" = m."id" AND e."model" = ${model})
      ORDER BY m."receivedAt" DESC
      LIMIT ${ATTACH_EMBED_PER_TICK * 4}`;

    const batch = pickFairBatch(candidates, ATTACH_EMBED_PER_USER_PER_TICK, ATTACH_EMBED_PER_TICK);

    let embedded = 0, tombstoned = 0, skipped = 0;
    for (const cand of batch) {
      try {
        const parts = await this.loadParts(cand);
        const inserted = await this.embedParts(cand, parts.filter(eligiblePart));
        if (inserted === 0) {
          await this.tombstone(cand.id);
          tombstoned++;
        } else {
          embedded++;
        }
        this.failures.delete(cand.id);
      } catch (err: any) {
        this.logger.warn(`attachment embed skip ${cand.id}: ${err?.message}`);
        const attempts = (this.failures.get(cand.id) ?? 0) + 1;
        if (attempts >= this.FAILURE_LIMIT) {
          await this.tombstone(cand.id);
          this.failures.delete(cand.id);
          tombstoned++;
        } else {
          this.failures.set(cand.id, attempts);
          skipped++;
        }
      }
    }

    if (embedded || tombstoned || skipped) {
      this.logger.log(`attachment embeddings: +${embedded} tombstoned ${tombstoned} skipped ${skipped}`);
    }
    return { embedded, tombstoned, skipped };
  }

  /** Cached attachments are [] until a getMessage hydration — hydrate then re-read. */
  private async loadParts(cand: AttachmentCandidate): Promise<AttachmentPart[]> {
    const read = () =>
      this.prisma.message.findUnique({ where: { id: cand.id }, select: { attachments: true } });
    let row = await read();
    let atts = Array.isArray(row?.attachments) ? (row!.attachments as unknown as AttachmentPart[]) : [];
    if (!atts.length) {
      await this.mail.getMessage(cand.userId, cand.id);
      row = await read();
      atts = Array.isArray(row?.attachments) ? (row!.attachments as unknown as AttachmentPart[]) : [];
    }
    return atts;
  }

  /** Downloads, extracts, chunks and embeds each part; returns rows inserted. Per-part errors skip that part only. */
  private async embedParts(cand: AttachmentCandidate, parts: AttachmentPart[]): Promise<number> {
    const inserts: Array<{ partId: string; filename: string; mimeType: string; chunk: string; vector: number[] }> = [];
    for (const part of parts) {
      try {
        const { stream, contentType, filename } = await this.mail.downloadAttachment(cand.userId, cand.id, part.id);
        const buf = await streamToBuffer(stream, MAX_ATTACHMENT_BYTES);
        const text = (await extractAttachmentText(buf, contentType, filename)).trim();
        if (!text) continue;
        const chunks = chunkPlainText(text, `Attachment: ${filename}`, MAX_CHUNKS_PER_ATTACHMENT);
        const vectors = await this.embedder.embed(chunks);
        chunks.forEach((chunk, i) =>
          inserts.push({ partId: part.id, filename, mimeType: contentType, chunk, vector: vectors[i] }),
        );
      } catch (err: any) {
        // Unsupported/corrupt part — skip it; a Zimbra/network error on the
        // FIRST part surfaces as zero inserts and the caller's failure counter
        // decides, which keeps transient outages from tombstoning instantly.
        if (this.isTransient(err)) throw err;
        this.logger.warn(`part ${part.id} of ${cand.id} skipped: ${err?.message}`);
      }
    }
    if (!inserts.length) return 0;
    await this.prisma.$transaction([
      this.prisma.attachmentEmbedding.deleteMany({ where: { messageId: cand.id } }),
      ...inserts.map((r, i) =>
        this.prisma.$executeRaw`
          INSERT INTO "attachment_embeddings"
            ("id", "messageId", "userId", "partId", "filename", "mimeType", "chunkIndex", "model", "chunkText", "embedding", "failed", "extractedAt")
          VALUES (${randomUUID()}, ${cand.id}, ${cand.userId}, ${r.partId}, ${r.filename}, ${r.mimeType},
                  ${inserts.filter((x) => x.partId === r.partId).indexOf(r)}, ${this.embedder.model}, ${r.chunk},
                  ${`[${r.vector.join(',')}]`}::vector, false, ${new Date()})`,
      ),
    ]);
    return inserts.length;
  }

  /** Zimbra/network/embedding failures are transient (retry via 3-strike); extraction errors are permanent. */
  private isTransient(err: any): boolean {
    const msg = String(err?.message ?? '');
    return !/unsupported attachment type|10MB read limit/i.test(msg);
  }

  private async tombstone(messageId: string): Promise<void> {
    // userId denormalized on the row; fetch it for the tombstone insert.
    const row = await this.prisma.message.findUnique({ where: { id: messageId }, select: { userId: true } });
    if (!row) return;
    await this.prisma.$transaction([
      this.prisma.attachmentEmbedding.deleteMany({ where: { messageId } }),
      this.prisma.attachmentEmbedding.create({
        data: {
          messageId, userId: row.userId, partId: TOMBSTONE_PART, filename: '', mimeType: '',
          chunkIndex: 0, model: this.embedder.model, chunkText: '', failed: true,
        },
      }),
    ]);
  }
}
```

Note for the chunkIndex expression inside the transaction: `inserts.filter((x) => x.partId === r.partId).indexOf(r)` computes the 0-based chunk index *within its part* — required by the unique key `(messageId, partId, chunkIndex, model)`.

- [ ] **Step 4: Register the provider**

In `apps/api/src/mail/mail.module.ts`, import and append `AttachmentEmbedWorkerService` to `providers`.

- [ ] **Step 5: Run the tests**

Run from `apps/api`: `npx jest src/mail/attachment-embed-worker.service.spec.ts`
Expected: PASS (5 tests). If the transient-failure test tombstones immediately, check `isTransient` — a mocked `'zimbra down'` error must count as transient.

- [ ] **Step 6: Document env vars**

Append to the env comment block in `apps/api/.env` (comments only, no live values):

```
# Attachment embedding worker: ATTACH_EMBED_PER_TICK (default 3),
# ATTACH_EMBED_PER_USER_PER_TICK (default 2), ATTACH_BACKFILL_DAYS (default 90)
```

- [ ] **Step 7: Full api suite + commit**

Run from `apps/api`: `npx jest`
Expected: PASS.

```bash
git add apps/api && git commit -m "feat(ai): attachment embedding worker — 5th cron, message-unit batches, tombstones"
```

---

### Task 4: Attachment retrieval leg + `searchAttachments`

**Files:**
- Modify: `apps/api/src/chat/retrieval.service.ts`
- Modify: `apps/api/src/chat/ask.service.ts:23` (degraded type only — the object is passed through)
- Test: `apps/api/src/chat/retrieval.service.spec.ts` (extend)

**Interfaces:**
- Produces:
  - `RetrievalResult.degraded` gains `attachment: boolean`.
  - `searchAttachments(userId: string, query: string, limit?: number): Promise<Array<{ messageId: string; filename: string; snippet: string; subject: string | null; fromEmail: string; receivedAt: Date }>>` — public, used by Task 6's tool.
  - Attachment hits fuse under key `` `mail:${messageId}` `` with context prefixed `[from attachment "<filename>"]`.

- [ ] **Step 1: Write the failing tests** (extend the existing spec, following its established mock style for `$queryRaw`/legs — read the file first and mirror how `vectorLeg` cases stub `prisma.$queryRaw`)

Test cases to add:
1. `retrieve` with an attachment row and a body row for the SAME messageId yields ONE source (fused by key), and its context is the vector chunk (vector leg listed first).
2. `retrieve` with an attachment row for a message the body legs missed yields a source whose context starts with `[from attachment "report.pdf"]`.
3. When the attachment SQL rejects, `degraded.attachment === true` and other legs still return.
4. `searchAttachments` dedupes to one row per (messageId, filename) and clamps snippet to 200 chars.
5. `retrieve` with `scope.docId` set does NOT run the attachment leg (docs-only scope).

- [ ] **Step 2: Run to verify failure**

Run from `apps/api`: `npx jest src/chat/retrieval.service.spec.ts`
Expected: FAIL — `attachment` missing from degraded / method not found.

- [ ] **Step 3: Implement**

In `retrieval.service.ts`:

(a) Add SQL + leg (below `vectorRows`):

```ts
private async attachmentRows(userId: string, vecText: string, limit: number) {
  return this.prisma.$queryRaw<Array<{
    messageId: string; chunkText: string; filename: string;
    subject: string | null; fromEmail: string; fromName: string | null;
    receivedAt: Date; distance: number;
  }>>`
    SELECT e."messageId", e."chunkText", e."filename",
           m."subject", m."fromEmail", m."fromName", m."receivedAt",
           (e."embedding" <=> ${vecText}::vector) AS distance
    FROM "attachment_embeddings" e
    JOIN "messages" m ON m."id" = e."messageId"
    WHERE e."userId" = ${userId} AND e."failed" = false AND e."embedding" IS NOT NULL AND e."model" = ${this.embedder.model}
    ORDER BY e."embedding" <=> ${vecText}::vector
    LIMIT ${limit}`;
}

private async attachmentLeg(userId: string, vecPromise: Promise<string>): Promise<FusableHit[]> {
  const rows = await this.attachmentRows(userId, await vecPromise, VECTOR_TOP_K);
  const seen = new Set<string>();
  const hits: FusableHit[] = [];
  for (const r of rows) {
    if (seen.has(r.messageId)) continue; // distance-ordered: best chunk per message
    seen.add(r.messageId);
    hits.push({
      key: `mail:${r.messageId}`, type: 'mail', id: r.messageId, title: r.subject,
      fromEmail: r.fromEmail, fromName: r.fromName, date: r.receivedAt,
      context: `[from attachment "${r.filename}"]\n${r.chunkText}`,
    });
  }
  return hits;
}
```

(b) In `retrieve()`: add the leg to the `allSettled` array (5th entry), gated `wantMail && !scope?.docId`; add `attachment: attachmentLeg.status === 'rejected'` to `degraded` (plus its warn log line); insert into the fuse order right after `vectorLeg` (vector chunks still win the shared-key payload; attachment context wins over keyword snippets):

```ts
const [vectorLeg, keywordLeg, docLeg, calendarLeg, attachLeg] = await Promise.allSettled([
  ...existing four...,
  wantMail && !scope?.docId ? this.attachmentLeg(userId, vecPromise!) : Promise.resolve<FusableHit[]>([]),
]);
// fuse order: vector, attachment, doc, calendar, keyword
```

(c) Public search method:

```ts
async searchAttachments(userId: string, query: string, limit = 8) {
  const vecText = await this.embedQuestion(query);
  const rows = await this.attachmentRows(userId, vecText, limit * 3);
  const seen = new Set<string>();
  const out: Array<{ messageId: string; filename: string; snippet: string; subject: string | null; fromEmail: string; receivedAt: Date }> = [];
  for (const r of rows) {
    const k = `${r.messageId}:${r.filename}`;
    if (seen.has(k) || out.length >= limit) continue;
    seen.add(k);
    out.push({
      messageId: r.messageId, filename: r.filename, snippet: r.chunkText.slice(0, 200),
      subject: r.subject, fromEmail: r.fromEmail, receivedAt: r.receivedAt,
    });
  }
  return out;
}
```

(d) In `ask.service.ts:23` extend the degraded type with `attachment: boolean`.

- [ ] **Step 4: Run tests**

Run from `apps/api`: `npx jest src/chat`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat && git commit -m "feat(ai): attachment vector leg fused on parent message + searchAttachments"
```

---

### Task 5: Stable aliases — `aliasFor(type, id)`

**Files:**
- Modify: `apps/api/src/agent/tool-registry.ts:12-18` (ToolContext)
- Modify: `apps/api/src/agent/agent.service.ts:59-65` (ctx construction)
- Modify: every `ctx.nextAlias()` call site — find with `grep -rn "nextAlias" apps/api/src`
- Test: `apps/api/src/agent/agent.service.spec.ts` or the tool spec that exercises refs (follow existing spec layout)

**Interfaces:**
- Produces: `ToolContext.aliasFor(type: 'mail' | 'doc' | 'event', id: string): string` — same alias for the same `(type, id)` within one agent turn; `nextAlias` is REMOVED (compile errors locate every call site).

- [ ] **Step 1: Write the failing test**

```ts
// in the spec that builds a real ToolContext via AgentService (or a focused new describe block)
it('aliasFor returns the same alias for the same source and new aliases for new sources', () => {
  // Build the ctx exactly as agent.service.run does:
  let aliasCount = 0;
  const aliasByKey = new Map<string, string>();
  const aliasFor = (type: string, id: string) => {
    const k = `${type}:${id}`;
    const hit = aliasByKey.get(k);
    if (hit) return hit;
    const a = `s${++aliasCount}`;
    aliasByKey.set(k, a);
    return a;
  };
  expect(aliasFor('mail', 'm1')).toBe('s1');
  expect(aliasFor('mail', 'm2')).toBe('s2');
  expect(aliasFor('mail', 'm1')).toBe('s1'); // repeat: stable
  expect(aliasFor('doc', 'm1')).toBe('s3');  // same id, different type: distinct
});
```

Additionally add an integration-style assertion in the mail tool spec: calling the search tool's `execute` twice with rows containing the same message id produces refs with the SAME alias both times.

- [ ] **Step 2: Run to verify failure** — the integration assertion fails while `nextAlias` exists.

- [ ] **Step 3: Implement**

`tool-registry.ts` ToolContext:

```ts
export interface ToolContext {
  userId: string;
  userEmail: string;
  /** Stable per-turn alias: the same (type, id) always maps to the same 'sN'. */
  aliasFor(type: 'mail' | 'doc' | 'event', id: string): string;
  emitChart(spec: ChartSpec): void;
}
```

`agent.service.ts` ctx (replacing lines 59-65):

```ts
let aliasCount = 0;
const aliasByKey = new Map<string, string>();
const ctx: ToolContext = {
  userId,
  userEmail: user?.email ?? '',
  aliasFor: (type, id) => {
    const k = `${type}:${id}`;
    const hit = aliasByKey.get(k);
    if (hit) return hit;
    const alias = `s${++aliasCount}`;
    aliasByKey.set(k, alias);
    return alias;
  },
  emitChart: (spec) => emit('chart', spec),
};
```

Update call sites (grep `nextAlias`): e.g. `mail.tools.ts` `mailRef` becomes `alias: ctx.aliasFor('mail', String(m.id))`; docs tools use `ctx.aliasFor('doc', id)`; calendar tools `ctx.aliasFor('event', id)`; `write.tools.ts` draft ref `ctx.aliasFor('mail', zimbraId)`. Run `npx tsc --noEmit` — the compiler finds any missed site.

- [ ] **Step 4: Run tests** — `npx jest src/agent` from `apps/api`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent && git commit -m "feat(ai): turn-scoped stable citation aliases (aliasFor replaces nextAlias)"
```

---

### Task 6: `search_attachments` agent tool

**Files:**
- Modify: `apps/api/src/agent/tools/attachment.tools.ts` (add builder; keep `buildAttachmentTool`)
- Modify: `apps/api/src/agent/agent.module.ts` (register in the same factory that calls `buildAttachmentTool` — pass the `RetrievalService` already injected there for the mail tools)
- Test: `apps/api/src/agent/tools/attachment.tools.spec.ts` (extend)

**Interfaces:**
- Consumes: `RetrievalService.searchAttachments` (Task 4), `ToolContext.aliasFor` (Task 5), `toIsoDate` from `../dates`.
- Produces: registered read tool `search_attachments` (registry count 20 → 21).

- [ ] **Step 1: Write the failing tests**

```ts
describe('search_attachments', () => {
  const rows = [
    { messageId: 'm9', filename: 'contract.pdf', snippet: 'penalty clause 4.2 …', subject: 'VAPT contract', fromEmail: 'a@risa.gov.rw', receivedAt: new Date('2026-09-01T08:00:00Z') },
  ];
  const retrieval: any = { searchAttachments: jest.fn().mockResolvedValue(rows) };
  const ctx: any = { userId: 'u1', aliasFor: jest.fn().mockReturnValue('s1') };

  it('returns refs with the parent message id and (id …) exposure in content', async () => {
    const tool = buildAttachmentSearchTool(retrieval);
    const res = await tool.execute({ query: 'penalty clause' } as any, ctx);
    expect(res.refs?.[0]).toMatchObject({ type: 'mail', id: 'm9', alias: 's1' });
    expect(res.content).toContain('(id m9)');
    expect(res.content).toContain('contract.pdf');
  });

  it('advertised schema carries no pattern keys', () => {
    const tool = buildAttachmentSearchTool(retrieval);
    const json = JSON.stringify(z.toJSONSchema(tool.schema));
    expect(json).not.toContain('"pattern"');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `buildAttachmentSearchTool` not exported.

- [ ] **Step 3: Implement** (in `attachment.tools.ts`)

```ts
import { toIsoDate } from '../dates';
import type { RetrievalService } from '../../chat/retrieval.service';

export function buildAttachmentSearchTool(retrieval: RetrievalService): ToolDef {
  return {
    name: 'search_attachments',
    description:
      'Semantic search INSIDE email attachments (PDF, DOCX and text file contents). Use when the user asks about the contents of a file — e.g. a term that would appear in a report or contract rather than the email body. Each result line includes the parent message id — pass THAT id to read_email or read_attachment, never the [sN] alias; never invent ids.',
    mode: 'read',
    resultBudget: 3000,
    schema: z.object({ query: z.string().min(2).max(200) }),
    async execute(args: any, ctx) {
      const rows = await retrieval.searchAttachments(ctx.userId, args.query, 8);
      const refs = rows.map((r) => ({
        alias: ctx.aliasFor('mail', r.messageId),
        type: 'mail' as const,
        id: r.messageId,
        title: r.subject,
        date: toIsoDate(r.receivedAt),
        snippet: `${r.filename}: ${r.snippet}`.slice(0, 160),
        injectionSuspected: false,
      }));
      const content = rows.length
        ? rows
            .map((r, i) =>
              `[${refs[i].alias}] (id ${r.messageId}) attachment "${r.filename}" on "${r.subject ?? '(no subject)'}" from ${r.fromEmail} on ${refs[i].date}\n${r.snippet}`,
            )
            .join('\n\n')
        : 'No attachment content matched.';
      return { summary: `${rows.length} attachment match(es)`, content, refs };
    },
  };
}
```

Register in `agent.module.ts` beside `buildAttachmentTool(...)`: `buildAttachmentSearchTool(retrieval)` — the factory already receives `RetrievalService` for the mail semantic tool; if the parameter list differs, follow the existing injection pattern in that factory.

- [ ] **Step 4: Run tests** — `npx jest src/agent/tools/attachment.tools.spec.ts`. Expected: PASS. Also assert the registry count in whichever spec pins the tool count (grep `20` / `openAiTools` in agent specs) and bump it to 21.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent && git commit -m "feat(ai): search_attachments tool — semantic search inside attachment content (21 tools)"
```

---

### Task 7: Doc-scoped ask depth

**Files:**
- Modify: `apps/api/src/chat/retrieval.service.ts` (docId branch + per-hit context cap)
- Test: `apps/api/src/chat/retrieval.service.spec.ts` (extend)

**Interfaces:**
- Consumes: `docVectorRows` (existing, already takes `docId`).
- Produces: unchanged public signature; behavioral contract — `scope.docId` ⇒ up to 6 chunks of that doc joined into ONE source whose context may exceed 1200 chars (cap 7400).

- [ ] **Step 1: Write the failing tests**

Cases (mirroring the spec's existing mock style):
1. `retrieve(userId, email, q, { docId: 'd1' })` with 6 chunk rows returns exactly ONE source of type `doc`, id `d1`, whose context contains text from the 1st AND 6th chunk and exceeds 1200 chars.
2. Without `docId`, two docs × 3 chunks each still yield 2 sources with one chunk each (regression guard on the cross-doc dedupe).

- [ ] **Step 2: Run to verify failure** — deep case yields a 1200-clamped single-chunk context today.

- [ ] **Step 3: Implement**

(a) Add to `FusableHit`: `contextMax?: number;`

(b) In `docVectorLeg`, branch on `docId`:

```ts
private async docVectorLeg(userId: string, userEmail: string, vecPromise: Promise<string>, docId?: string): Promise<FusableHit[]> {
  if (docId) return this.docDeepLeg(userId, userEmail, vecPromise, docId);
  ...existing body unchanged...
}

private static readonly DOC_SCOPED_CHUNKS = 6;
private static readonly DOC_SCOPED_MAX_CHARS = 7400; // 6 chunks × 1200 + separators

/** docId scope: the top chunks of ONE document, joined into one deep context under one chip. */
private async docDeepLeg(userId: string, userEmail: string, vecPromise: Promise<string>, docId: string): Promise<FusableHit[]> {
  const rows = await this.docVectorRows(userId, userEmail, await vecPromise, RetrievalService.DOC_SCOPED_CHUNKS, docId);
  if (!rows.length) return [];
  return [{
    key: `doc:${docId}`, type: 'doc', id: docId, title: rows[0].title,
    date: rows[0].updatedAt, meta: rows[0].emoji ?? null,
    context: rows.map((r) => r.chunkText).join('\n[…]\n'),
    contextMax: RetrievalService.DOC_SCOPED_MAX_CHARS,
  }];
}
```

(c) In `assembleContexts`, replace the final clamp `context.slice(0, CONTEXT_MAX_CHARS)` with `context.slice(0, h.contextMax ?? CONTEXT_MAX_CHARS)`.

- [ ] **Step 4: Run tests** — `npx jest src/chat`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat && git commit -m "feat(ai): doc-scoped asks read the top 6 chunks as one deep context"
```

---

### Task 8: Web — source dedupe + attachment degraded notice

**Files:**
- Modify: `apps/web/lib/ai/agent.ts` (new pure helper `mergeSources`; degraded/ask types if declared here — check `lib/ai/ask.ts` for the degraded shape and extend with `attachment?: boolean`)
- Modify: `apps/web/components/ai/AskPanel.tsx:428-440` (use `mergeSources`); the degraded-notice block near line 74 gains the attachment line
- Test: `apps/web/lib/ai/agent.test.ts` (or the existing test file beside it)

**Interfaces:**
- Produces: `mergeSources(prev: AskSource[], incoming: AskSource[]): AskSource[]` — appends only unseen aliases; a repeated alias arriving with `injectionSuspected: true` upgrades the existing entry's flag; returns `prev` (same reference) when nothing changed.

- [ ] **Step 1: Write the failing tests**

```ts
import { mergeSources } from './agent';

const src = (alias: string, flagged = false) =>
  ({ alias, type: 'mail', id: `id-${alias}`, title: 't', date: '2026-09-08', snippet: '', injectionSuspected: flagged }) as any;

describe('mergeSources', () => {
  it('appends unseen aliases only', () => {
    const out = mergeSources([src('s1')], [src('s1'), src('s2')]);
    expect(out.map((s) => s.alias)).toEqual(['s1', 's2']);
  });
  it('upgrades the injection flag on a flagged repeat', () => {
    const out = mergeSources([src('s1')], [src('s1', true)]);
    expect(out[0].injectionSuspected).toBe(true);
  });
  it('returns the same reference when nothing changes', () => {
    const prev = [src('s1')];
    expect(mergeSources(prev, [src('s1')])).toBe(prev);
  });
});
```

- [ ] **Step 2: Run to verify failure** — from `apps/web`: `npx vitest run lib/ai/agent.test.ts`. Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

In `lib/ai/agent.ts`:

```ts
/** Accumulates rail sources across tool_result frames. Server aliases are
 * turn-stable (aliasFor), so a repeated alias is the SAME item — drop it,
 * but let a flagged repeat upgrade the stored injection flag. */
export function mergeSources(prev: AskSource[], incoming: AskSource[]): AskSource[] {
  const byAlias = new Map(prev.map((s) => [s.alias, s]));
  let changed = false;
  const out = [...prev];
  for (const s of incoming) {
    const existing = byAlias.get(s.alias);
    if (!existing) {
      byAlias.set(s.alias, s);
      out.push(s);
      changed = true;
    } else if (s.injectionSuspected && !existing.injectionSuspected) {
      out[out.indexOf(existing)] = { ...existing, injectionSuspected: true };
      changed = true;
    }
  }
  return changed ? out : prev;
}
```

In `AskPanel.tsx` `onStepResult` (lines 428-440), replace the append with:

```ts
const merged = mergeSources(pendingSourcesRef.current, stamped);
if (merged !== pendingSourcesRef.current) {
  pendingSourcesRef.current = merged;
  setPendingSources(merged);
}
```

Degraded notice: extend the degraded type with `attachment?: boolean` (wherever `{ vector: boolean; keyword: boolean; docs: boolean; calendar: boolean }` is declared in `apps/web/lib/ai/ask.ts`) and add beside AskPanel line 74's pattern:

```ts
if (degraded.attachment) lines.push('Attachment search unavailable — the answer may be missing file contents.');
```

- [ ] **Step 4: Run tests** — from `apps/web`: `npx vitest run lib/ai components/ai`. Expected: PASS (new + existing; existing AskPanel tests must not regress).

- [ ] **Step 5: Commit**

```bash
git add apps/web && git commit -m "feat(ai): dedupe rail sources by stable alias; attachment degraded notice"
```

---

### Task 9: Full gates, deploy, live sweep

**Files:** none new (build scripts exist: `scripts/build-api.sh`, `scripts/build-web-154.sh`, `scripts/build-web-155.sh`).

- [ ] **Step 1: Full test + type gates**

```bash
cd apps/api && npx tsc --noEmit && npx jest
cd ../web && npx tsc --noEmit && npx vitest run
```

Expected: all green.

- [ ] **Step 2: Containerized builds**

Run `scripts/build-api.sh`, then `scripts/build-web-154.sh` and `scripts/build-web-155.sh` (output in `.build-out/`). Run build and any deploy as SEPARATE commands (never `build | tail && deploy` — the pipe masks failures). Verify the api tarball's prisma client: `tar -tzf .build-out/api-<rev>.tar.gz | grep -c ".prisma/client"` — expected 17.

- [ ] **Step 3: Push and deploy .154 then .155**

Push `ft-hyperscale`. Deploy with the established swap recipe (scp tarballs, stop units, `.bak-<ts>` swap, `npx prisma migrate deploy` with api.env sourced — expect exactly `add_attachment_embeddings` pending — restart `govmail-api govmail-web`). `.155` uses PG on 5433 and the TLS-edge probe `curl --resolve test1.risa.gov.rw:443:<ip>`. Verify 200/401 probes and that boot logs map the routes.

- [ ] **Step 4: Watch the worker**

On .154: `journalctl -u govmail-api -f | grep -i "attachment embeddings"` — expect `+N` ticks while backfilling, then silence. Spot-check rows: count > 0 in `attachment_embeddings` via the node/pg one-liner pattern.

- [ ] **Step 5: Live sweep (Chrome, Bruce's session on .154)** — record outcomes:
1. Ask the agent for a term that appears ONLY inside a known PDF (the RHEMIS inception report) — expect a `search_attachments` step, a correct citation, and `read_attachment` chaining if asked to elaborate.
2. A repeated-search conversation (same person/topic three ways) — sources rail shows each message once.
3. "Ask this document" on a long doc — answer draws from multiple sections, still one chip.
4. Kill the Ollama embed model temporarily is NOT required — degraded flags are covered by unit tests; skip destructive probes.
5. Dismiss any event proposals with real attendees — never save them.

- [ ] **Step 6: Close out**

Update the memory stream file, mark deploy revs on both VM memories, and commit any doc updates.

---

## Self-review notes (already applied)

- Spec coverage: §1 ingest → Tasks 2-3; §1.4 leg → Task 4; §1.5 tool → Task 6; §2 dedup → Tasks 5+8; §3 depth → Task 7; §4 testing/rollout → embedded per task + Task 9. Spec's alias/context-block refinements were amended into the spec before this plan was written.
- Type consistency: `aliasFor` defined in Task 5 and consumed in Task 6; `searchAttachments` row shape defined in Task 4 and consumed in Task 6; `contextMax` defined and consumed in Task 7 only; `mergeSources` defined and consumed in Task 8.
- The executor must mirror EXISTING spec files' mock styles when extending `retrieval.service.spec.ts` — read the file before writing tests.
