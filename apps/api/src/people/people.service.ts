import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 86_400_000;
const STATS_WINDOW_DAYS = 90;
const RECENT_MESSAGE_SCAN = 50; // rows scanned to derive 8 conversations + display name
const MAX_CONVERSATIONS = 8;
const EVENT_WINDOW_DAYS = 365;
const MAX_UPCOMING_EVENTS = 5;
const MAX_PAST_EVENTS = 3;

export interface PersonDossier {
  profile: {
    email: string;
    name: string | null;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    received90d: number;
    sent90d: number;
  };
  recentConversations: Array<{
    messageId: string;
    conversationId: string | null;
    subject: string | null;
    snippet: string | null;
    direction: 'in' | 'out';
    at: string;
  }>;
  commitments: Array<{
    id: string;
    type: 'promised' | 'waiting';
    text: string;
    dueHint: string | null;
    messageId: string;
    lastActivityAt: string;
  }>;
  sharedEvents: Array<{
    id: string;
    title: string;
    startAt: string;
    endAt: string;
    upcoming: boolean;
  }>;
  sharedDocs: Array<{
    id: string;
    title: string;
    emoji: string | null;
    direction: 'i-shared' | 'they-shared';
  }>;
}

/**
 * Deterministic per-counterparty facts. A "person" is a lowercased email
 * address; involvement = they sent it (fromEmail) OR they're in toRecipients
 * ({email,name} JSONB elements — see mail.service.ts sync mapping).
 */
@Injectable()
export class PeopleService {
  constructor(private readonly prisma: PrismaService) {}

  async dossier(userId: string, rawEmail: string): Promise<PersonDossier> {
    const email = rawEmail.trim().toLowerCase();
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (me?.email?.toLowerCase() === email) {
      throw new BadRequestException('cannot open a dossier on yourself');
    }

    const cutoff = new Date(Date.now() - STATS_WINDOW_DAYS * DAY_MS);

    // The involvement predicate appears in three queries below — keep the
    // copies textually identical (fromEmail leg is indexed; the toRecipients
    // EXISTS leg is a scan, fine at this corpus size).
    const [stats] = await this.prisma.$queryRaw<
      Array<{
        firstSeenAt: Date | null;
        lastSeenAt: Date | null;
        received90d: number;
        sent90d: number;
      }>
    >`
      SELECT min(m."receivedAt") AS "firstSeenAt", max(m."receivedAt") AS "lastSeenAt",
             count(*) FILTER (WHERE lower(m."fromEmail") = ${email} AND m."receivedAt" >= ${cutoff})::int AS "received90d",
             count(*) FILTER (WHERE lower(m."fromEmail") <> ${email} AND m."receivedAt" >= ${cutoff})::int AS "sent90d"
      FROM "messages" m
      WHERE m."userId" = ${userId} AND m."isDraft" = false
        AND (lower(m."fromEmail") = ${email}
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(m."toRecipients") r
                        WHERE lower(r->>'email') = ${email}))`;

    const recent = await this.prisma.$queryRaw<
      Array<{
        id: string;
        conversationId: string | null;
        subject: string | null;
        snippet: string | null;
        fromEmail: string;
        fromName: string | null;
        receivedAt: Date;
      }>
    >`
      SELECT m."id", m."conversationId", m."subject", m."snippet", m."fromEmail", m."fromName", m."receivedAt"
      FROM "messages" m
      WHERE m."userId" = ${userId} AND m."isDraft" = false
        AND (lower(m."fromEmail") = ${email}
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(m."toRecipients") r
                        WHERE lower(r->>'email') = ${email}))
      ORDER BY m."receivedAt" DESC
      LIMIT ${RECENT_MESSAGE_SCAN}`;

    const name =
      recent.find((m) => m.fromEmail.toLowerCase() === email && m.fromName)?.fromName ?? null;

    const seenConvs = new Set<string>();
    const recentConversations: PersonDossier['recentConversations'] = [];
    for (const m of recent) {
      const key = m.conversationId ?? `msg:${m.id}`;
      if (seenConvs.has(key)) continue;
      seenConvs.add(key);
      recentConversations.push({
        messageId: m.id,
        conversationId: m.conversationId,
        subject: m.subject,
        snippet: m.snippet,
        direction: m.fromEmail.toLowerCase() === email ? 'in' : 'out',
        at: m.receivedAt.toISOString(),
      });
      if (recentConversations.length >= MAX_CONVERSATIONS) break;
    }

    const commitmentRows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        type: string;
        text: string;
        dueHint: string | null;
        messageId: string;
        lastActivityAt: Date;
      }>
    >`
      SELECT c."id", c."type", c."text", c."dueHint", c."messageId", c."lastActivityAt"
      FROM "commitments" c
      JOIN "messages" m ON m."id" = c."messageId"
      WHERE c."userId" = ${userId} AND c."status" = 'open'
        AND (lower(m."fromEmail") = ${email}
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(m."toRecipients") r
                        WHERE lower(r->>'email') = ${email}))
      ORDER BY c."lastActivityAt" DESC`;

    const now = Date.now();
    const eventRows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        title: string;
        startAt: Date;
        endAt: Date;
      }>
    >`
      SELECT e."id", e."title", e."startAt", e."endAt"
      FROM "calendar_events" e
      WHERE e."userId" = ${userId}
        AND e."startAt" BETWEEN ${new Date(now - EVENT_WINDOW_DAYS * DAY_MS)} AND ${new Date(now + EVENT_WINDOW_DAYS * DAY_MS)}
        AND (lower(coalesce(e."organizer", '')) = ${email}
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(e."attendees") a
                        WHERE lower(a->>'email') = ${email}))`;
    const upcoming = eventRows
      .filter((e) => e.startAt.getTime() >= now)
      .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
      .slice(0, MAX_UPCOMING_EVENTS);
    const past = eventRows
      .filter((e) => e.startAt.getTime() < now)
      .sort((a, b) => b.startAt.getTime() - a.startAt.getTime())
      .slice(0, MAX_PAST_EVENTS);
    const sharedEvents = [...upcoming, ...past].map((e) => ({
      id: e.id,
      title: e.title,
      startAt: e.startAt.toISOString(),
      endAt: e.endAt.toISOString(),
      upcoming: e.startAt.getTime() >= now,
    }));

    const iShared = await this.prisma.documentInvite.findMany({
      where: { invitedEmail: { equals: email, mode: 'insensitive' }, document: { userId } },
      select: { document: { select: { id: true, title: true, emoji: true } } },
    });
    const theyShared = await this.prisma.documentInvite.findMany({
      where: {
        invitedEmail: { equals: me?.email ?? '', mode: 'insensitive' },
        document: { user: { email: { equals: email, mode: 'insensitive' } } },
      },
      select: { document: { select: { id: true, title: true, emoji: true } } },
    });

    return {
      profile: {
        email,
        name,
        firstSeenAt: stats?.firstSeenAt?.toISOString() ?? null,
        lastSeenAt: stats?.lastSeenAt?.toISOString() ?? null,
        received90d: stats?.received90d ?? 0,
        sent90d: stats?.sent90d ?? 0,
      },
      recentConversations,
      commitments: commitmentRows.map((c) => ({
        id: c.id,
        type: c.type as 'promised' | 'waiting',
        text: c.text,
        dueHint: c.dueHint,
        messageId: c.messageId,
        lastActivityAt: c.lastActivityAt.toISOString(),
      })),
      sharedEvents,
      sharedDocs: [
        ...iShared.map((i) => ({ ...i.document, direction: 'i-shared' as const })),
        ...theyShared.map((i) => ({ ...i.document, direction: 'they-shared' as const })),
      ],
    };
  }
}
