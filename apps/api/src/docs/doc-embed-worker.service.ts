import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { docJsonToText, chunkDocForEmbedding } from '@email-client/shared';
import { PrismaService } from '../prisma/prisma.service';
import { EmbedderService } from '../mail/embedder.service';
import { pickFairBatch } from '../mail/card-worker.service';

const DOC_EMBED_BATCH_PER_TICK = Number(process.env.DOC_EMBED_BATCH_PER_TICK ?? 8);
const DOC_EMBED_PER_USER_PER_TICK = Number(process.env.DOC_EMBED_PER_USER_PER_TICK ?? 2);

/** Candidate identity — content is fetched later, only for the picked batch. */
interface DocEmbedCandidate {
  id: string;
  userId: string;
  title: string;
  updatedAt: Date;
}

/**
 * Doc embedding worker — a sibling of EmbedWorkerService (mail) with the same
 * skeleton: minute tick, fair per-user batching, newest-first, 3-strike
 * in-memory failure counter -> tombstone. Unlike the mail worker there is no
 * time-window backfill or purge: a document lives until its owner deletes it,
 * and re-embedding is driven purely by staleness (`updatedAt` vs. the current
 * model's `sourceUpdatedAt`), not by an age cutoff. That staleness test is
 * evaluated in SQL, so the per-tick LIMIT bounds work rather than eligibility.
 */
@Injectable()
export class DocEmbedWorkerService {
  private readonly logger = new Logger(DocEmbedWorkerService.name);

  /** Consecutive failure counts, in-memory only (resets on restart — same tradeoff as mail/cards). */
  private failures = new Map<string, number>();
  private readonly FAILURE_LIMIT = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedder: EmbedderService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { waitForCompletion: true })
  async tick() {
    try {
      await this.processTick();
    } catch (err: any) {
      this.logger.error(`processTick failed: ${err?.message}`);
    }
  }

  async processTick(): Promise<{ embedded: number; tombstoned: number; skipped: number; refreshed: number }> {
    // Staleness lives in SQL. Prisma's query builder can't compare two columns
    // (document.updatedAt vs. the embedding row's sourceUpdatedAt), and doing
    // it in JS after a bounded `take` permanently starved every document
    // outside the globally-newest window — once those were embedded the
    // filter emptied the batch and nothing else was ever selected. The NOT
    // EXISTS predicate below excludes already-current documents in the
    // database, so the LIMIT applies to genuinely-stale candidates only.
    const model = this.embedder.model;
    const candidates = await this.prisma.$queryRaw<DocEmbedCandidate[]>`
      SELECT d."id", d."userId", d."title", d."updatedAt"
      FROM "documents" d
      JOIN "users" u ON u."id" = d."userId"
      WHERE d."content" IS NOT NULL AND d."content" <> ''
        AND u."authToken" IS NOT NULL AND u."tokenExpiry" > NOW()
        AND NOT EXISTS (
          SELECT 1 FROM "document_embeddings" e
          WHERE e."documentId" = d."id"
            AND e."model" = ${model}
            AND e."sourceUpdatedAt" >= d."updatedAt")
      ORDER BY d."updatedAt" DESC
      LIMIT ${DOC_EMBED_BATCH_PER_TICK * 4}`;

    const batch = pickFairBatch(candidates, DOC_EMBED_PER_USER_PER_TICK, DOC_EMBED_BATCH_PER_TICK);

    let embedded = 0;
    let tombstoned = 0;
    let skipped = 0;
    let refreshed = 0;

    // Content is pulled only for the picked batch — the candidate query above
    // deliberately carries no `content` so the discarded 3/4 of the headroom
    // never ships document bodies over the wire.
    const contentRows = batch.length
      ? await this.prisma.document.findMany({
          where: { id: { in: batch.map((d) => d.id) } },
          select: { id: true, content: true },
        })
      : [];
    const contentById = new Map(contentRows.map((r) => [r.id, r.content]));

    for (const doc of batch) {
      try {
        const text = docJsonToText(contentById.get(doc.id) ?? '');
        if (!text) {
          // No extractable text — a permanent condition, tombstone without retries.
          await this.tombstone(doc);
          tombstoned++;
          continue;
        }
        const chunks = chunkDocForEmbedding(text, doc.title);

        // Live collaboration bumps Document.updatedAt (@updatedAt) every ~2s
        // while an editor is open, even when nothing textual changed. Rather
        // than re-embedding identical text once a minute, compare the freshly
        // extracted chunks against what's already stored for this model and,
        // when they match, just move `sourceUpdatedAt` forward so the SQL
        // staleness predicate stops selecting the document.
        if (await this.refreshIfUnchanged(doc, chunks)) {
          this.failures.delete(doc.id);
          refreshed++;
          continue;
        }

        const vectors = await this.embedder.embed(chunks);
        await this.prisma.$transaction([
          this.prisma.documentEmbedding.deleteMany({ where: { documentId: doc.id } }),
          ...chunks.map((chunk, i) =>
            this.prisma.$executeRaw`
              INSERT INTO "document_embeddings"
                ("id", "documentId", "chunkIndex", "model", "chunkText", "embedding", "failed", "sourceUpdatedAt", "extractedAt")
              VALUES (${randomUUID()}, ${doc.id}, ${i}, ${this.embedder.model}, ${chunk},
                      ${`[${vectors[i].join(',')}]`}::vector, false, ${doc.updatedAt}, ${new Date()})`,
          ),
        ]);
        this.failures.delete(doc.id);
        embedded++;
      } catch (err: any) {
        this.logger.warn(`doc embed skip ${doc.id}: ${err?.message}`);
        const attempts = (this.failures.get(doc.id) ?? 0) + 1;
        if (attempts >= this.FAILURE_LIMIT) {
          await this.tombstone(doc);
          this.failures.delete(doc.id);
          tombstoned++;
        } else {
          this.failures.set(doc.id, attempts);
          skipped++;
        }
      }
    }

    if (embedded || tombstoned || skipped || refreshed) {
      this.logger.log(
        `doc embeddings: +${embedded} refreshed ${refreshed} tombstoned ${tombstoned} skipped ${skipped}`,
      );
    }

    return { embedded, tombstoned, skipped, refreshed };
  }

  /**
   * True when the document's current-model rows already hold exactly these
   * chunk texts, in this order, with no tombstone among them. In that case the
   * rows are left untouched apart from `sourceUpdatedAt`/`extractedAt`, which
   * move forward to the document's current `updatedAt` so the staleness
   * predicate stops re-selecting it.
   */
  private async refreshIfUnchanged(doc: DocEmbedCandidate, chunks: string[]): Promise<boolean> {
    const existing = await this.prisma.documentEmbedding.findMany({
      where: { documentId: doc.id, model: this.embedder.model },
      orderBy: { chunkIndex: 'asc' },
      select: { chunkText: true, failed: true },
    });
    if (existing.length !== chunks.length) return false;
    if (existing.some((row, i) => row.failed || row.chunkText !== chunks[i])) return false;

    await this.prisma.documentEmbedding.updateMany({
      where: { documentId: doc.id, model: this.embedder.model },
      data: { sourceUpdatedAt: doc.updatedAt, extractedAt: new Date() },
    });
    return true;
  }

  /**
   * Replace every embedding row for this document with a single current-model
   * tombstone, atomically. Deleting only other-model rows used to leave a
   * previously-embedded document's live chunks retrievable forever once it
   * later failed or lost its text; the delete is unqualified by model so the
   * document ends with exactly one row: the failed marker.
   */
  private async tombstone(doc: { id: string; updatedAt: Date }): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.documentEmbedding.deleteMany({ where: { documentId: doc.id } }),
      this.prisma.documentEmbedding.create({
        data: {
          documentId: doc.id,
          chunkIndex: 0,
          model: this.embedder.model,
          chunkText: '',
          failed: true,
          sourceUpdatedAt: doc.updatedAt,
          extractedAt: new Date(),
        },
      }),
    ]);
  }
}
