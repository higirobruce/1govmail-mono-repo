import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { MailProviderResolver } from './mail-provider.resolver';

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
  it('resolves MailProviderResolver for every feature module in AppModule', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(moduleRef.get(MailProviderResolver, { strict: false })).toBeInstanceOf(
      MailProviderResolver,
    );
  });
});
