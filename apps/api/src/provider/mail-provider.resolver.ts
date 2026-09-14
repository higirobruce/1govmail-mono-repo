import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { User } from '@prisma/client';
import { MailProvider } from './mail-provider.interface';
import { ZimbraService } from '../zimbra/zimbra.service';
import { MemoryMailProvider } from './memory/memory-mail.provider';
import { EwsService } from '../ews/ews.service';

/**
 * The single seam between the feature services and a concrete mail backend.
 *
 * Feature services never import a provider implementation: they hold this
 * resolver, call `forUser(user)` per request, and talk to the returned
 * `MailProvider` through the neutral interface with a `MailSession` built by
 * `buildMailSession`. Phase 2 (memory) and Phase 3 (EWS) register their
 * implementation in the switch below — no feature service changes.
 *
 * `User.provider` is the branch key (stamped at login from the Institution
 * registry), which is why `buildMailSession` insists on carrying the column.
 */
@Injectable()
export class MailProviderResolver {
  constructor(
    private readonly zimbraService: ZimbraService,
    // Optional so the resolver still constructs where memory is not wired
    // (unit tests, older DI graphs). ProviderModule always provides it; the
    // env gate below — not its presence — decides whether it is handed out.
    @Optional() private readonly memoryProvider?: MemoryMailProvider,
    // Optional for the same reason (a few unit tests construct the resolver
    // without it). ProviderModule imports EwsModule and always provides it;
    // unlike memory there is NO env gate — the Institution table is what
    // decides who is `ews`.
    @Optional() private readonly ewsService?: EwsService,
  ) {}

  forUser(user: Pick<User, 'provider'>): MailProvider {
    switch (user.provider) {
      case 'zimbra':
        return this.zimbraService;
      case 'memory':
        // Gated on MAIL_PROVIDER_MEMORY: with the flag off, memory is refused
        // like an unregistered provider — fall through to the
        // BadRequestException below so a build that ships without the flag
        // never exposes the fake backend.
        if (process.env.MAIL_PROVIDER_MEMORY === 'true' && this.memoryProvider) {
          return this.memoryProvider;
        }
        break;
      case 'ews':
        // A real provider (Phase 3), no env gate. In the rare DI graph where it
        // was not provided, fall through to the 400 rather than return
        // undefined — ProviderModule always provides it in production.
        if (this.ewsService) {
          return this.ewsService;
        }
        break;
    }
    // A 400, not a 500: the account is on a backend this build does not speak
    // (or is not permitted to speak) yet. This is also the login gate —
    // AuthService resolves the institution's provider through here instead of
    // hard-coding a "zimbra only" check.
    throw new BadRequestException(
      `Mail provider "${user.provider}" is not supported on this server yet.`,
    );
  }

  /**
   * Logout hook: tear down any per-session transport state for this user.
   * Only EWS caches a keep-alive https.Agent per mailbox (NTLM authenticates
   * the connection, so the socket is authenticated); dropping it on logout
   * stops a later session reusing a stale authenticated socket. Every other
   * provider is stateless per session, so this is a no-op for them.
   * Kept off the MailProvider interface — it is a transport lifecycle concern,
   * not a mail operation.
   */
  evictSession(user: Pick<User, 'provider'>, email: string): void {
    if (user.provider === 'ews') {
      this.ewsService?.evictSession(email);
    }
  }

  /** Zimbra-only extras (downloadZimbraPath, galSelfLookup). Callers must
   *  check user.provider === 'zimbra' and degrade gracefully otherwise. */
  zimbra(): ZimbraService { return this.zimbraService; }
}
