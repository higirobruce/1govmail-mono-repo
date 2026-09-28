/** Beyond this many, expanding a group would bury the compose form in chips. */
export const MAX_EXPANDED_MEMBERS = 50;

/**
 * Member addresses worth adding as recipients: trimmed, non-empty, and
 * de-duplicated case-insensitively against each other and anything already present.
 */
export function dedupeMemberEmails(
  members: Array<{ email: string }>,
  alreadyPresent: string[] = [],
): string[] {
  const seen = new Set(alreadyPresent.map((e) => e.trim().toLowerCase()));
  const fresh: string[] = [];
  for (const m of members) {
    const email = (m.email ?? '').trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(email);
  }
  return fresh;
}
