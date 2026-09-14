import { UnauthorizedException } from '@nestjs/common';
import { User } from '@prisma/client';
import { EwsCrypto } from '../ews/ews-crypto';

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

/**
 * Module-level, lazily-constructed `EwsCrypto`. `buildMailSession` is
 * synchronous and called on every request, so the (deliberately slow) scrypt
 * key derivation must happen once, not per call — a singleton memoizes it.
 * It is constructed lazily, on the first EWS session, rather than at module
 * load: a deployment that never touches EWS (no `MAIL_CRED_KEY` set) must
 * still be able to boot and build Zimbra/memory sessions. If an EWS session
 * is requested and the key is missing, `EwsCrypto`'s own constructor throws
 * the clear `/MAIL_CRED_KEY/` error — that's surfaced as-is, not caught here.
 */
let ewsCrypto: EwsCrypto | undefined;
function getEwsCrypto(): EwsCrypto {
  if (!ewsCrypto) ewsCrypto = new EwsCrypto();
  return ewsCrypto;
}

/** The ONLY place User columns map to a provider session.
 *  `provider` is required but not yet read — it becomes the branch key in
 *  Phase 3. Requiring it now (Task 9, Task 6 controller ruling) is what forces
 *  every narrowed `select` that feeds a session to carry the column, so the
 *  Phase 3 switch cannot be reached with the field silently absent. Call sites
 *  holding a projection widen the projection (see DocsService.addInvite).
 *
 *  Phase 3: for `provider === 'ews'`, `user.authToken` is not a bearer token
 *  at all — it's an `EwsCrypto` blob encrypting the mailbox's
 *  `{ username, password }` (written at login, Task 8). Decrypt it into
 *  `credentials` and leave `authToken`/`csrfToken` unset; every other
 *  provider is untouched. */
export function buildMailSession(user: MailSessionUser): MailSession {
  if (user.provider === 'ews') {
    // An ews `authToken` is the encrypted credential blob written at login. A
    // null/empty one means the session is gone (or was never established);
    // feeding that to EwsCrypto.decrypt yields a cryptic crypto error, so guard
    // it into a clear re-login prompt BEFORE attempting to decrypt.
    if (!user.authToken) {
      throw new UnauthorizedException('Your session is no longer valid. Please log in again.');
    }
    const credentials = JSON.parse(getEwsCrypto().decrypt(user.authToken)) as {
      username: string;
      password: string;
    };
    return {
      host: user.zimbraHost,
      email: user.email,
      credentials,
    };
  }

  return {
    host: user.zimbraHost,
    email: user.email,
    authToken: user.authToken ?? undefined,
    csrfToken: user.csrfToken ?? undefined,
  };
}
