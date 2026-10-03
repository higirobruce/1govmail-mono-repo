import { MAX_EXPANDED_MEMBERS, dedupeMemberEmails } from './groupRecipients';

/**
 * Compose URL that opens a new message addressed to a group's members.
 * Members are a snapshot of addresses, so this is plain de-duplication —
 * nothing downstream needs to know the group existed.
 *
 * The recipient list is capped at MAX_EXPANDED_MEMBERS (same cap the
 * compose chip input uses), but unlike the chip input this URL has no way
 * to carry a clickable "+N more" tail — so the omitted count is returned
 * alongside the url for the caller to surface (e.g. a toast) rather than
 * silently dropping recipients.
 */
export function composeUrlForGroup(members: Array<{ email: string }>): {
  url: string;
  omitted: number;
} {
  const deduped = dedupeMemberEmails(members);
  const addresses = deduped.slice(0, MAX_EXPANDED_MEMBERS);
  const omitted = deduped.length - addresses.length;
  if (addresses.length === 0) return { url: '/mail?compose=1', omitted };
  const qs = new URLSearchParams({ compose: '1', to: addresses.join(',') });
  return { url: `/mail?${qs.toString()}`, omitted };
}
