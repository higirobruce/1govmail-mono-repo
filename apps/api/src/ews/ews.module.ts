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
 * SECURITY / fail-fast: `new EwsService(...)` asserts `MAIL_CRED_KEY` at
 * construction. Booting an app that has an `ews` institution but no key throws
 * here at startup — the correct, loud failure, not a mid-login surprise.
 */
@Module({
  providers: [
    { provide: EwsTransport, useFactory: () => new EwsTransport() },
    {
      provide: EwsService,
      useFactory: (transport: EwsTransport) => new EwsService(transport),
      inject: [EwsTransport],
    },
  ],
  exports: [EwsService],
})
export class EwsModule {}
