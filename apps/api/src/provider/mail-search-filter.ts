/** Provider-agnostic structured mail search. Every field optional; present
 *  fields combine with AND. Booleans: true/false select that state, undefined
 *  means "either". Empty/whitespace strings are treated as absent. */
export interface MailSearchFilter {
  keyword?: string;
  from?: string;
  to?: string;
  subject?: string;
  dateFrom?: string;   // 'YYYY-MM-DD', inclusive
  dateTo?: string;     // 'YYYY-MM-DD', inclusive
  hasAttachment?: boolean;
  folderId?: string;
  unread?: boolean;
  flagged?: boolean;
}

const hasText = (v?: string) => typeof v === 'string' && v.trim().length > 0;

/** True when the filter would match the whole mailbox (nothing to search on).
 *  A `false` boolean is a real constraint (read-only / unflagged-only), so it
 *  counts; only `undefined` booleans and empty strings are "absent". */
export function isEmptyFilter(f: MailSearchFilter): boolean {
  return (
    !hasText(f.keyword) && !hasText(f.from) && !hasText(f.to) && !hasText(f.subject) &&
    !hasText(f.dateFrom) && !hasText(f.dateTo) && !hasText(f.folderId) &&
    f.hasAttachment === undefined && f.unread === undefined && f.flagged === undefined
  );
}

/** Zimbra query literal: wrap in quotes, escape backslash then double-quote, so
 *  operator words inside a user value are inert. */
export function quoteZimbra(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** AQS literal: AQS has no escape sequence, so strip embedded quotes and wrap. */
export function quoteAqs(v: string): string {
  return `"${v.replace(/"/g, '')}"`;
}
