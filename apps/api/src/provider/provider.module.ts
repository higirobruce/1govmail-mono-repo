import { Module } from '@nestjs/common';
import { ZimbraModule } from '../zimbra/zimbra.module';
import { MailProviderResolver } from './mail-provider.resolver';

/**
 * The provider layer's Nest surface. Feature modules import THIS (not
 * ZimbraModule) and inject `MailProviderResolver`; the concrete
 * implementations stay behind it. Phase 2/3 add their module to `imports`
 * here and their case to the resolver's switch — nothing else moves.
 */
@Module({
  imports: [ZimbraModule],
  providers: [MailProviderResolver],
  exports: [MailProviderResolver],
})
export class ProviderModule {}
