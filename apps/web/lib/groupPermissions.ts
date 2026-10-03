export interface GroupInvite {
  id: string;
  invitedEmail: string;
  role: 'VIEWER' | 'EDITOR';
}

export interface PermissionedGroup {
  userId?: string;
  invites?: GroupInvite[];
}

/**
 * Ownership must fail closed: an unknown/missing userId is never treated as
 * "owned by me". The API always returns userId on a group, so there is no
 * legitimate case where this fallback would be needed.
 */
export function isGroupOwner(
  g: PermissionedGroup | null,
  currentUserId: string | null | undefined,
): boolean {
  return !!g && !!currentUserId && g.userId === currentUserId;
}

/**
 * An EDITOR invitee may edit name/description/members even though they are
 * not the owner; a VIEWER may only view and send.
 *
 * `GET /contacts/groups` returns the group's ENTIRE invite list (every
 * invitee's role), not just the caller's row — so this must match on the
 * caller's OWN invite (by email, case-insensitively, matching the server's
 * trim+lowercase normalisation), never on "does anyone hold EDITOR".
 */
export function canEditGroup(
  g: PermissionedGroup | null,
  currentUserId: string | null | undefined,
  currentUserEmail: string | null | undefined,
): boolean {
  if (isGroupOwner(g, currentUserId)) return true;
  if (!currentUserEmail) return false;
  const normalizedSelf = currentUserEmail.trim().toLowerCase();
  if (!normalizedSelf) return false;
  return !!g?.invites?.some(
    (i) => i.role === 'EDITOR' && i.invitedEmail.trim().toLowerCase() === normalizedSelf,
  );
}
