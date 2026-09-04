export interface Recipient {
  email: string;
  name?: string | null;
}

export interface ReplySource {
  fromEmail: string;
  fromName: string | null;
  toRecipients: Recipient[];
  ccRecipients?: Recipient[];
}

/**
 * Compute the recipients an inline reply goes to.
 * reply     → the sender (or, when replying to your own message, its To list).
 * replyAll  → sender + every To recipient, CC preserved; you are removed
 *             everywhere and duplicates collapse (case-insensitive).
 */
export function computeReplyRecipients(
  msg: ReplySource,
  mode: 'reply' | 'replyAll',
  currentUserEmail: string,
): { to: Recipient[]; cc: Recipient[] } {
  const me = currentUserEmail.toLowerCase();
  const fromIsMe = msg.fromEmail.toLowerCase() === me;

  if (mode === 'reply') {
    if (fromIsMe) {
      return { to: msg.toRecipients.filter((r) => r.email.toLowerCase() !== me), cc: [] };
    }
    return { to: [{ email: msg.fromEmail, name: msg.fromName }], cc: [] };
  }

  const seen = new Set<string>([me]);
  const push = (arr: Recipient[], r: Recipient) => {
    const key = r.email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    arr.push(r);
  };

  const to: Recipient[] = [];
  push(to, { email: msg.fromEmail, name: msg.fromName });
  msg.toRecipients.forEach((r) => push(to, r));

  const cc: Recipient[] = [];
  (msg.ccRecipients ?? []).forEach((r) => push(cc, r));

  return { to, cc };
}
