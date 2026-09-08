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

  /** Downloads, extracts, chunks and embeds each part; returns rows inserted. Only extraction errors are permanent (per-part); download/embedding errors bubble up to message-level 3-strike counter. */
  private async embedParts(cand: AttachmentCandidate, parts: AttachmentPart[]): Promise<number> {
    const inserts: Array<{ partId: string; filename: string; mimeType: string; chunk: string; vector: number[] }> = [];
    for (const part of parts) {
      // Download and buffer conversion — transient (Zimbra/network) failures rethrow for 3-strike.
      const dl = await this.mail.downloadAttachment(cand.userId, cand.id, part.id);
      const buf = await streamToBuffer(dl.stream, MAX_ATTACHMENT_BYTES);

      // Extraction only — permanent (unsupported/corrupt) failures skip this part.
      let text;
      try {
        text = (await extractAttachmentText(buf, dl.contentType, dl.filename)).trim();
      } catch (err: any) {
        // Permanent extraction error: log and skip this part; other parts in the message still get processed.
        this.logger.warn(`part ${part.id} of ${cand.id} skipped: ${err?.message}`);
        continue;
      }

      if (!text) continue;

      // Chunking and embedding — transient failures (Ollama down) rethrow for 3-strike.
      const chunks = chunkPlainText(text, `Attachment: ${dl.filename}`, MAX_CHUNKS_PER_ATTACHMENT);
      const vectors = await this.embedder.embed(chunks);
      chunks.forEach((chunk, i) =>
        inserts.push({ partId: part.id, filename: dl.filename, mimeType: dl.contentType, chunk, vector: vectors[i] }),
      );
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
