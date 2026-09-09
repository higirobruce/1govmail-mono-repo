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

/** The ONLY place User columns map to a provider session.
 *  `provider` is accepted but not yet read — it becomes the branch key in
 *  Phase 3, and staying optional lets call sites that hold a narrowed user
 *  projection (e.g. DocsService.sendInviteEmail) build a session too. */
export function buildMailSession(
  user: Pick<User, 'zimbraHost' | 'email' | 'authToken' | 'csrfToken'> & Partial<Pick<User, 'provider'>>,
): MailSession {
  return {
    host: user.zimbraHost,
    email: user.email,
    authToken: user.authToken ?? undefined,
    csrfToken: user.csrfToken ?? undefined,
  };
}
