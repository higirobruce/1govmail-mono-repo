import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { User } from '@prisma/client';
import { MailProvider } from './mail-provider.interface';
import { ZimbraService } from '../zimbra/zimbra.service';
import { MemoryMailProvider } from './memory/memory-mail.provider';

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
  ) {}

  forUser(user: Pick<User, 'provider'>): MailProvider {
    switch (user.provider) {
      case 'zimbra':
        return this.zimbraService;
      case 'memory':
        // Gated on MAIL_PROVIDER_MEMORY: with the flag off, memory is refused
        // exactly like ews — fall through to the BadRequestException below so
        // a build that ships without the flag never exposes the fake backend.
        if (process.env.MAIL_PROVIDER_MEMORY === 'true' && this.memoryProvider) {
          return this.memoryProvider;
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

  /** Zimbra-only extras (downloadZimbraPath, galSelfLookup). Callers must
   *  check user.provider === 'zimbra' and degrade gracefully otherwise. */
  zimbra(): ZimbraService { return this.zimbraService; }
}
