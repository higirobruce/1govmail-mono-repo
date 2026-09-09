import { User } from '@prisma/client';

export interface MailSession {
  host: string;
  email: string;
  /** Zimbra: server-issued token. EWS (later): encrypted credentials live here too. */
  authToken?: string;
  csrfToken?: string;
  /** EWS only (Phase 3): decrypted per request by this helper. */
  credentials?: { username: string; password: string };
}

/** The User columns a provider call needs: the session inputs plus
 *  `provider`, which MailProviderResolver.forUser branches on. Handy for the
 *  few internal helpers that are handed a user row rather than a userId — a
 *  session alone is not enough to pick a provider. */
export type MailSessionUser = Pick<
  User, 'zimbraHost' | 'email' | 'authToken' | 'csrfToken' | 'provider'
>;

/** The ONLY place User columns map to a provider session.
 *  `provider` is required but not yet read — it becomes the branch key in
 *  Phase 3. Requiring it now (Task 9, Task 6 controller ruling) is what forces
 *  every narrowed `select` that feeds a session to carry the column, so the
 *  Phase 3 switch cannot be reached with the field silently absent. Call sites
 *  holding a projection widen the projection (see DocsService.addInvite). */
export function buildMailSession(user: MailSessionUser): MailSession {
  return {
    host: user.zimbraHost,
    email: user.email,
    authToken: user.authToken ?? undefined,
    csrfToken: user.csrfToken ?? undefined,
  };
}
