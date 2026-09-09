import {
  ProviderAddress,
  ProviderAttachmentMeta,
  ProviderFolder,
  ProviderMessage,
} from '../provider/provider-types';

// ─── Zimbra wire shapes ──────────────────────────────────────────────────────
// These describe what Zimbra's JSON SOAP actually returns. They live here (not
// in zimbra.service.ts) so the mappers are the single place that knows the wire
// vocabulary — `su`, `fr`, `e[]`, `mp[]`, the flag chars in `f`, `tn`. Nothing
// outside this file and ZimbraService should reference them.

export interface ZimbraFolder {
  id: string;
  name: string;
  absFolderPath: string;
  u?: number;  // unread count
  n?: number;  // total count
  color?: number;
  l?: string;  // parent id
  view?: string; // folder type: 'message' | 'contact' | 'appointment' | 'task' | 'document' | …
}

export interface ZimbraMessage {
  id: string;
  cid?: string; // conversation id
  l: string;   // folder id
  f?: string;  // flags: u=unread, f=flagged, a=has-attachment, d=draft, r=replied, w=forwarded
  s: number;   // size
  d: number;   // date (ms)
  su?: string; // subject
  fr?: string; // fragment/snippet
  tn?: string; // comma-separated tag names
  e?: ZimbraEmailAddress[];
  mp?: ZimbraMessagePart[];
}

export interface ZimbraEmailAddress {
  a: string;  // address
  d?: string; // display name
  t: string;  // type: f=from, t=to, c=cc, b=bcc, r=reply-to
}

export interface ZimbraMessagePart {
  part: string;
  ct: string;   // content type
  body?: boolean;
  content?: string;
  mp?: ZimbraMessagePart[];
  filename?: string;
  ci?: string;  // content-id (inline images carry it, wrapped in angle brackets)
  s?: number;   // size
}

// ─── Messages ────────────────────────────────────────────────────────────────

/** Addresses of one role, in wire order. `name` stays `undefined` (not null)
 *  when Zimbra omits the display name — callers that need null apply their own
 *  `?? null`, and JSON.stringify drops the key exactly as it did before. */
function addressesOfRole(addrs: ZimbraEmailAddress[], role: string): ProviderAddress[] {
  return addrs.filter((a) => a.t === role).map((a) => ({ email: a.a, name: a.d }));
}

/** First part (depth-first) whose content type matches and which Zimbra marked
 *  as the display body. */
function extractBody(parts: ZimbraMessagePart[], contentType: string): string | null {
  for (const part of parts) {
    if (part.ct === contentType && part.body) return part.content ?? null;
    if (part.mp) {
      const found = extractBody(part.mp, contentType);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Walk the MIME tree once and collect every file-bearing part, tagging each as
 * inline or not.
 *
 * A part is *inline* when it carries a content-id and an `image/*` type and is
 * not the display body (signature logos, pasted images, tracking pixels). It is
 * a real *attachment* when it has a filename, is not the display body, and is
 * not an inline image — surfacing inline images as attachments would pollute
 * attachment counts and the "has attachment" filter.
 */
function collectAttachments(parts: ZimbraMessagePart[]): ProviderAttachmentMeta[] {
  const result: ProviderAttachmentMeta[] = [];
  for (const part of parts) {
    const isInlineImage = !!(part.ci && part.ct?.startsWith('image/'));
    if (isInlineImage && !part.body) {
      result.push({
        part: String(part.part),
        filename: part.filename ?? '',
        contentType: part.ct,
        size: part.s ?? 0,
        isInline: true,
        // CIDs come wrapped in angle brackets; HTML `src="cid:…"` never has them.
        contentId: part.ci!.replace(/^<|>$/g, ''),
      });
    } else if (part.filename && !part.body && !isInlineImage) {
      result.push({
        part: String(part.part),
        filename: part.filename,
        contentType: part.ct ?? 'application/octet-stream',
        size: part.s ?? 0,
        isInline: false,
        contentId: undefined,
      });
    }
    if (part.mp) result.push(...collectAttachments(part.mp));
  }
  return result;
}

export function mapZimbraMessage(raw: ZimbraMessage): ProviderMessage {
  const flags = raw.f ?? '';
  const addrs = raw.e ?? [];
  const from = addrs.find((a) => a.t === 'f');
  const parts = raw.mp ?? [];

  return {
    id: String(raw.id),
    conversationId: raw.cid != null ? String(raw.cid) : null,
    folderId: String(raw.l),
    subject: raw.su ?? null,
    snippet: raw.fr ?? null,
    from: { email: from?.a ?? '', name: from?.d },
    to: addressesOfRole(addrs, 't'),
    cc: addressesOfRole(addrs, 'c'),
    // Bcc is only ever visible on the user's own sent/draft items.
    bcc: addressesOfRole(addrs, 'b'),
    receivedAt: new Date(raw.d),
    size: raw.s ?? 0,
    isRead: !flags.includes('u'),
    isFlagged: flags.includes('f'),
    isDraft: flags.includes('d'),
    // List and search hits carry no part tree, so attachment presence comes
    // from the flag — never from walking `mp`.
    hasAttachments: flags.includes('a'),
    tags: raw.tn ? raw.tn.split(',') : [],
    bodyHtml: extractBody(parts, 'text/html'),
    bodyText: extractBody(parts, 'text/plain'),
    attachments: collectAttachments(parts),
  };
}

// ─── Folders ─────────────────────────────────────────────────────────────────

export function mapZimbraFolder(raw: ZimbraFolder): ProviderFolder {
  return {
    id: String(raw.id),              // Zimbra may return numeric IDs
    name: raw.name ?? 'Unnamed',
    path: raw.absFolderPath ?? (raw.name ? `/${raw.name}` : '/'),
    unreadCount: typeof raw.u === 'number' ? raw.u : 0,
    totalCount: typeof raw.n === 'number' ? raw.n : 0,
    parentId: raw.l != null ? String(raw.l) : undefined,
    view: raw.view ?? undefined,
  };
}
