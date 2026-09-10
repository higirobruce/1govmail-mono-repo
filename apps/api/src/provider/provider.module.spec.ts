import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { MailProviderResolver } from './mail-provider.resolver';
import { EwsService } from '../ews/ews.service';

/**
 * The injection swap's guard rail. Every feature service now takes
 * MailProviderResolver instead of a provider implementation, which is a
 * DI-graph change no unit test can see: each of the seven feature modules had
 * to swap `ZimbraModule` for `ProviderModule`. Compiling the real AppModule
 * fails loudly ("Nest can't resolve dependencies of the …Service") if one of
 * them is missed — verified by removing the import and watching this fail.
 *
 * `compile()` only builds the injector: no lifecycle hooks run, so nothing
 * here touches Postgres, Zimbra or the network.
 */
describe('ProviderModule wiring', () => {
  // EwsModule (Phase 3) is now part of the graph; its EwsService factory
  // asserts MAIL_CRED_KEY at construction, so a key must be present for the
  // AppModule to boot. Set a throwaway one for the compile (the real value is
  // an ops secret; see .env.example / ARCHITECTURE §8).
  const ORIGINAL_KEY = process.env.MAIL_CRED_KEY;
  beforeAll(() => {
    process.env.MAIL_CRED_KEY ??= 'test-mail-cred-key-provider-module-spec';
  });
  afterAll(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.MAIL_CRED_KEY;
    else process.env.MAIL_CRED_KEY = ORIGINAL_KEY;
  });

  it('resolves MailProviderResolver for every feature module in AppModule', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(moduleRef.get(MailProviderResolver, { strict: false })).toBeInstanceOf(
      MailProviderResolver,
    );
  });

  it('registers the EWS provider so an ews user resolves to the EwsService', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    const resolver = moduleRef.get(MailProviderResolver, { strict: false });
    const ews = moduleRef.get(EwsService, { strict: false });
    expect(ews).toBeInstanceOf(EwsService);
    expect(resolver.forUser({ provider: 'ews' } as any)).toBe(ews);
  });
});
