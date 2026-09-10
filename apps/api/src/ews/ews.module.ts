import { Module } from '@nestjs/common';
import { EwsService } from './ews.service';
import { EwsTransport } from './ews-transport';

/**
 * The EWS (Exchange Web Services) provider's Nest surface (Phase 3).
 *
 * `ProviderModule` imports THIS and the resolver hands out `EwsService` for
 * `User.provider === 'ews'`. The subtree depends on nothing in the feature
 * modules — only `EwsTransport` (NTLM/keep-alive HTTP) and, internally,
 * `EwsCrypto` (credential AES-256-GCM, constructed inside `EwsService`, not a
 * DI dep) — so it adds no edge to the module graph and keeps it acyclic.
 *
 * Both are wired via `useFactory` (like the memory pair in ProviderModule):
 * neither class carries `@Injectable()`/emitted paramtypes, and the factory
 * form lets `EwsService` construct with the singleton `EwsTransport` (whose
 * per-mailbox keep-alive agent cache must be shared so logout eviction reaches
 * the same instance).
 *
 * SECURITY / lazy key: `MAIL_CRED_KEY` is required ONLY when an `ews`
 * institution is actually configured — it is not a whole-app boot requirement.
 * A Zimbra-only deployment has no key and must still boot, so the `EwsService`
 * factory yields `null` when the key is absent rather than constructing (which
 * would throw the constructor's assertion). The resolver injects `EwsService`
 * with `@Optional()` and, for a `provider === 'ews'` user with a null service,
 * falls through to the standard "not supported on this server" 400. When the
 * key IS present the factory constructs normally and the constructor's own
 * `MAIL_CRED_KEY` assertion remains the fail-fast for a malformed key.
 */
@Module({
  providers: [
    { provide: EwsTransport, useFactory: () => new EwsTransport() },
    {
      provide: EwsService,
      useFactory: (transport: EwsTransport): EwsService | null =>
        process.env.MAIL_CRED_KEY ? new EwsService(transport) : null,
      inject: [EwsTransport],
    },
  ],
  exports: [EwsService],
})
export class EwsModule {}
