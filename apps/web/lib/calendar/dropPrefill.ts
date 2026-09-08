/** Payload carried on a mail drag: `application/x-govmail-msg` (drag-and-drop
 *  onto the calendar grid or sidebar) and `sessionStorage` (sidebar-drop
 *  redirect). Kept minimal and untyped-JSON-safe — always parse defensively. */
export interface MailDragPayload {
  id: string;
  subject: string;
  snippet: string;
  from: string;
}

/** Parse + shape-check a raw drag/session payload. Returns null on anything
 *  that isn't a JSON object with a string `id` (garbage, wrong shape, etc). */
export function parseMailDragPayload(raw: string): MailDragPayload | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const obj = data as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !obj.id) return null;

  return {
    id: obj.id,
    subject: typeof obj.subject === 'string' ? obj.subject : '',
    snippet: typeof obj.snippet === 'string' ? obj.snippet : '',
    from: typeof obj.from === 'string' ? obj.from : '',
  };
}

/** Build the calendar-modal prefill fields from a parsed mail drag payload.
 *  Keeps the message id on both `linkedMessageId` (shown as a link once
 *  saved) and `aiFillMessageId` (triggers the live AI fill in the modal). */
export function dropPrefillFromPayload(p: MailDragPayload): {
  title: string;
  description: string;
  linkedMessageId: string;
  linkedSubject: string;
  aiFillMessageId: string;
} {
  return {
    title: p.subject,
    description: `From: ${p.from}\n\n${p.snippet}`,
    linkedMessageId: p.id,
    linkedSubject: p.subject,
    aiFillMessageId: p.id,
  };
}
