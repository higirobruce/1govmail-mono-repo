import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { PublicAskSource } from './ask.service';

export type GenerationKind = 'dossier' | 'meeting_prep';

export interface CachedGeneration {
  content: string;
  sources: PublicAskSource[];
  generatedAt: string; // ISO
  stale: boolean;
}

/**
 * Server-side cache for dossier / meeting-prep generations. Staleness is
 * computed at READ time against the stored sourceAnchor:
 *  - dossier: any mail involving the person newer than the anchor
 *  - meeting_prep: event.updatedAt past the anchor, or newer INBOUND mail
 *    from any attendee (outbound is skipped deliberately — a cheap
 *    fromEmail-indexed check; regeneration is user-initiated anyway).
 * Stale rows are still served with stale:true — never auto-regenerated.
 */
@Injectable()
export class GenerationCacheService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string, kind: GenerationKind, targetKey: string): Promise<CachedGeneration | null> {
    const row = await this.prisma.aiGeneration.findUnique({
      where: { userId_kind_targetKey: { userId, kind, targetKey } },
    });
    if (!row) return null;

    let stale = false;
    if (kind === 'dossier') {
      const newest = await this.newestInvolving(userId, [targetKey]);
      stale = !!newest && newest.getTime() > row.sourceAnchor.getTime();
    } else {
      const event = await this.prisma.calendarEvent.findFirst({
        where: { id: targetKey, userId },
        select: { updatedAt: true, attendees: true },
      });
      if (!event) return null; // event deleted or not the caller's — cache row is orphaned
      stale = event.updatedAt.getTime() > row.sourceAnchor.getTime();
      if (!stale) {
        const emails = (Array.isArray(event.attendees) ? (event.attendees as Array<{ email?: string }>) : [])
          .map((a) => a?.email?.toLowerCase()).filter((e): e is string => !!e);
        if (emails.length) {
          const newest = await this.newestFrom(userId, emails);
          stale = !!newest && newest.getTime() > row.sourceAnchor.getTime();
        }
      }
    }

    return {
      content: row.content,
      sources: (row.sources as unknown as PublicAskSource[]) ?? [],
      generatedAt: row.generatedAt.toISOString(),
      stale,
    };
  }

  async upsert(
    userId: string, kind: GenerationKind, targetKey: string,
    data: { content: string; sources: PublicAskSource[]; model: string; sourceAnchor: Date },
  ): Promise<void> {
    const payload = {
      content: data.content,
      sources: data.sources as unknown as object,
      model: data.model,
      sourceAnchor: data.sourceAnchor,
      generatedAt: new Date(),
    };
    await this.prisma.aiGeneration.upsert({
      where: { userId_kind_targetKey: { userId, kind, targetKey } },
      create: { userId, kind, targetKey, ...payload },
      update: payload,
    });
  }

  /** Newest mail involving the (lowercased) email in either direction. */
  private async newestInvolving(userId: string, emails: string[]): Promise<Date | null> {
    const [row] = await this.prisma.$queryRaw<Array<{ newest: Date | null }>>`
      SELECT max(m."receivedAt") AS newest FROM "messages" m
      WHERE m."userId" = ${userId} AND m."isDraft" = false
        AND (lower(m."fromEmail") = ANY(${emails}::text[])
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(m."toRecipients") r
                        WHERE lower(r->>'email') = ANY(${emails}::text[])))`;
    return row?.newest ?? null;
  }

  /** Newest INBOUND mail from any of the (lowercased) emails — fromEmail index only. */
  private async newestFrom(userId: string, emails: string[]): Promise<Date | null> {
    const [row] = await this.prisma.$queryRaw<Array<{ newest: Date | null }>>`
      SELECT max(m."receivedAt") AS newest FROM "messages" m
      WHERE m."userId" = ${userId} AND m."isDraft" = false
        AND lower(m."fromEmail") = ANY(${emails}::text[])`;
    return row?.newest ?? null;
  }
}
