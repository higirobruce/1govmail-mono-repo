import { MAX_EXPANDED_MEMBERS, dedupeMemberEmails } from './groupRecipients';

/**
 * Compose URL that opens a new message addressed to a group's members.
 * Members are a snapshot of addresses, so this is plain de-duplication —
 * nothing downstream needs to know the group existed.
 */
export function composeUrlForGroup(members: Array<{ email: string }>): string {
  const addresses = dedupeMemberEmails(members).slice(0, MAX_EXPANDED_MEMBERS);
  if (addresses.length === 0) return '/mail?compose=1';
  const qs = new URLSearchParams({ compose: '1', to: addresses.join(',') });
  return `/mail?${qs.toString()}`;
}
