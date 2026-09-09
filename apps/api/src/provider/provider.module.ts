import { Module } from '@nestjs/common';
import { ZimbraModule } from '../zimbra/zimbra.module';
import { MailProviderResolver } from './mail-provider.resolver';
import { MemoryStore } from './memory/memory-store';
import { MemoryMailProvider } from './memory/memory-mail.provider';

/**
 * The provider layer's Nest surface. Feature modules import THIS (not
 * ZimbraModule) and inject `MailProviderResolver`; the concrete
 * implementations stay behind it. Phase 2/3 add their module to `imports`
 * here and their case to the resolver's switch — nothing else moves.
 *
 * The memory subtree (`MemoryStore` → `MemoryMailProvider`) depends on nothing
 * in the feature modules, so it adds no edge to the module graph — it is a
 * pair of plain providers built here. `MemoryStore` is a single shared
 * instance (all seeded demo mailboxes live in its Map for the process
 * lifetime); `MemoryMailProvider` wraps it and is injected into the resolver.
 * It is always provided, but the resolver only hands it out when
 * `MAIL_PROVIDER_MEMORY==='true'`.
 */
@Module({
  imports: [ZimbraModule],
  providers: [
    { provide: MemoryStore, useFactory: () => new MemoryStore() },
    {
      provide: MemoryMailProvider,
      useFactory: (store: MemoryStore) => new MemoryMailProvider(store),
      inject: [MemoryStore],
    },
    MailProviderResolver,
  ],
  exports: [MailProviderResolver],
})
export class ProviderModule {}
