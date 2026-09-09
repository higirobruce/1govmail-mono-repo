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

/** The ONLY place User columns map to a provider session. */
export function buildMailSession(user: Pick<User, 'zimbraHost' | 'email' | 'authToken' | 'csrfToken' | 'provider'>): MailSession {
  return {
    host: user.zimbraHost,
    email: user.email,
    authToken: user.authToken ?? undefined,
    csrfToken: user.csrfToken ?? undefined,
  };
}
