import { type OrgItem } from './org.types';

interface Range {
  aheadFrom: Date; aheadTo: Date; pastFrom: Date; pastTo: Date;
}

/**
 * Documents and minutes the institution deliberately made collective.
 * Retrospective only — a document has no future date, so this contributes
 * nothing to the `ahead` lane.
 *
 * A document qualifies on `isShared` (a share link exists) or on having at
 * least one invite. Both are explicit acts by the owner, which is what makes
 * surfacing them disclose nothing new.
 */
export async function selectDocumentsAndMinutes(
  prisma: any,
  institutionId: string,
  range: Range,
): Promise<{ concluded: OrgItem[] }> {
  const [docs, minutes] = await Promise.all([
    prisma.document.findMany({
      where: {
        user: { institutionId },
        updatedAt: { gte: range.pastFrom, lte: range.pastTo },
        OR: [{ isShared: true }, { invites: { some: {} } }],
      },
      select: { id: true, title: true, updatedAt: true, invites: { select: { id: true } } },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.meetingMinutes.findMany({
      where: {
        document: { user: { institutionId } },
        createdAt: { gte: range.pastFrom, lte: range.pastTo },
      },
      select: {
        id: true, createdAt: true, documentId: true,
        document: { select: { title: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const items: OrgItem[] = [
    ...docs.map((d: any) => ({
      kind: 'document' as const,
      id: d.id,
      title: d.title,
      at: d.updatedAt.toISOString(),
      participantCount: d.invites?.length ?? 0,
      href: `/docs?open=${d.id}`,
    })),
    ...minutes.map((m: any) => ({
      kind: 'minutes' as const,
      id: m.id,
      title: m.document?.title ?? 'Meeting minutes',
      at: m.createdAt.toISOString(),
      participantCount: 0,
      href: `/docs?open=${m.documentId}`,
    })),
  ];

  items.sort((a, b) => b.at.localeCompare(a.at));
  return { concluded: items };
}
