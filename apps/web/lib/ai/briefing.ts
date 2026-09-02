/**
 * Executive-briefing map-reduce pipeline:
 * fetch inbox & sent → hydrate with body/snippet → per-message cards → reduce to summary.
 */

export type BriefingWindow = 'today' | '24h' | 'week';
export const BRIEFING_MESSAGE_CAP = 50;

export interface BriefingSourceMessage {
  id: string;
  conversationId: string | null;
  direction: 'received' | 'sent';
  fromEmail: string;
  fromName: string | null;
  subject: string | null;
  receivedAt: string;               // ISO
  bodyText?: string | null;
  bodyHtml?: string | null;
  snippet?: string | null;
  attachments: string[];            // "name.pdf (2.1MB)"
}

export function windowStart(window: BriefingWindow, now: Date): Date {
  if (window === '24h') return new Date(now.getTime() - 24 * 3_600_000);
  if (window === 'week') return new Date(now.getTime() - 7 * 24 * 3_600_000);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1_048_576).toFixed(1)}MB`;
}

function toSource(raw: unknown, direction: 'received' | 'sent'): BriefingSourceMessage | null {
  const m = raw as Record<string, any>;
  if (!m || typeof m.id !== 'string' || typeof m.receivedAt !== 'string') return null;
  const attachments = Array.isArray(m.attachments)
    ? m.attachments
        .filter((a: any) => a && typeof a.filename === 'string')
        .map((a: any) => `${a.filename}${formatSize(a.size) ? ` (${formatSize(a.size)})` : ''}`)
    : [];
  return {
    id: m.id,
    conversationId: typeof m.conversationId === 'string' ? m.conversationId : null,
    direction,
    fromEmail: typeof m.fromEmail === 'string' ? m.fromEmail : '',
    fromName: typeof m.fromName === 'string' ? m.fromName : null,
    subject: typeof m.subject === 'string' ? m.subject : null,
    receivedAt: m.receivedAt,
    bodyText: m.bodyText ?? null,
    bodyHtml: m.bodyHtml ?? null,
    snippet: m.snippet ?? null,
    attachments,
  };
}

export function selectWindowMessages(
  inbox: unknown[], sent: unknown[], window: BriefingWindow, now: Date,
  cap: number = BRIEFING_MESSAGE_CAP,
): { selected: BriefingSourceMessage[]; totalInWindow: number } {
  const start = windowStart(window, now).getTime();
  const all = [
    ...inbox.map((m) => toSource(m, 'received')),
    ...sent.map((m) => toSource(m, 'sent')),
  ].filter((m): m is BriefingSourceMessage => m !== null)
   .filter((m) => {
     const t = Date.parse(m.receivedAt);
     return Number.isFinite(t) && t >= start && t <= now.getTime();
   })
   .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  return { selected: all.slice(0, cap), totalInWindow: all.length };
}
