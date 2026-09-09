import { BadRequestException, Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { MailProvider } from './mail-provider.interface';
import { ZimbraService } from '../zimbra/zimbra.service';

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
  constructor(private readonly zimbraService: ZimbraService) {}

  forUser(user: Pick<User, 'provider'>): MailProvider {
    switch (user.provider) {
      case 'zimbra': return this.zimbraService;
      default:
        // A 400, not a 500: the account is on a backend this build does not
        // speak yet. This is also the login gate — AuthService resolves the
        // institution's provider through here instead of hard-coding a
        // "zimbra only" check.
        throw new BadRequestException(
          `Mail provider "${user.provider}" is not supported on this server yet.`,
        );
    }
  }

  /** Zimbra-only extras (downloadZimbraPath, galSelfLookup). Callers must
   *  check user.provider === 'zimbra' and degrade gracefully otherwise. */
  zimbra(): ZimbraService { return this.zimbraService; }
}
