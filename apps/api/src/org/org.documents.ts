import { type OrgItem } from './org.types';

interface Range {
  aheadFrom: Date; aheadTo: Date; pastFrom: Date; pastTo: Date;
}

/**
 * Documents and minutes the institution deliberately made collective.
 * Retrospective only — a document has no future date, so this contributes
 * nothing to the `ahead` lane.
 *
 * A document qualifies on its own `orgVisible` flag. New documents are visible
 * by default and the owner can switch one off — so the digest shows what the
 * institution is working on without anyone having to opt each file in.
 *
 * Only the title and date are announced. The contents stay behind the document's
 * own permissions, and `docHref` still links only documents with a share token,
 * so a visible-but-unshared row renders as plain text rather than a dead link.
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
        orgVisible: true,
      },
      select: {
        id: true, title: true, updatedAt: true, isShared: true, shareToken: true,
        invites: { select: { id: true } },
      },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.meetingMinutes.findMany({
      where: {
        document: { user: { institutionId }, orgVisible: true },
        createdAt: { gte: range.pastFrom, lte: range.pastTo },
      },
      select: {
        id: true, createdAt: true, documentId: true,
        document: { select: { title: true, isShared: true, shareToken: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  // `/docs?open=:id` requires ownership or an invite — docs.service.ts throws
  // ForbiddenException for a non-owner without one, which is exactly the
  // isShared case this lane selects. Only the publicly-resolvable share link
  // is safe to hand to every reader in the institution; everything else gets
  // no href rather than a link that silently 403s.
  const docHref = (d: { isShared: boolean; shareToken: string | null }): string | undefined =>
    d.isShared && d.shareToken ? `/docs/share/${d.shareToken}` : undefined;

  // A minutes document is itself a Document, so both queries select it and the
  // digest announced it twice (seen live on .155: the same title and date in two
  // adjacent rows). The minutes row wins — it carries the meeting meaning, where
  // the document row is incidental to how minutes happen to be stored.
  //
  // Keyed on the minutes rows actually selected, never on "has minutes at all":
  // when a document is in the window but its minutes row is not, nothing else
  // would announce it and dropping it would lose the item outright.
  const announcedAsMinutes = new Set<string>(
    minutes.map((m: any) => m.documentId).filter(Boolean),
  );

  const items: OrgItem[] = [
    ...docs
      .filter((d: any) => !announcedAsMinutes.has(d.id))
      .map((d: any) => ({
      kind: 'document' as const,
      id: d.id,
      title: d.title,
      at: d.updatedAt.toISOString(),
      participantCount: d.invites?.length ?? 0,
      href: docHref(d),
    })),
    ...minutes.map((m: any) => ({
      kind: 'minutes' as const,
      id: m.id,
      title: m.document?.title ?? 'Meeting minutes',
      at: m.createdAt.toISOString(),
      participantCount: 0,
      href: m.document ? docHref(m.document) : undefined,
    })),
  ];

  items.sort((a, b) => b.at.localeCompare(a.at));
  return { concluded: items };
}
