import 'reflect-metadata'; // ValidateNested/@Type decorators need Reflect.getMetadata — normally polyfilled by main.ts at boot
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AskRequestDto } from './ask.dto';

// Mirrors main.ts's global `new ValidationPipe({ whitelist: true, transform: true })` —
// a rejected `validate()` here is exactly what becomes a 400 at the HTTP layer.
async function errorsFor(body: unknown) {
  const dto = plainToInstance(AskRequestDto, body);
  return validate(dto, { whitelist: true });
}

describe('AskRequestDto', () => {
  it('accepts messages with no scope', async () => {
    const errors = await errorsFor({ messages: [{ role: 'user', content: 'hi' }] });
    expect(errors).toHaveLength(0);
  });

  it('accepts a scope with types and docId', async () => {
    const errors = await errorsFor({
      messages: [{ role: 'user', content: 'hi' }],
      scope: { types: ['mail', 'doc'], docId: 'd1' },
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects a bad scope.types value', async () => {
    const errors = await errorsFor({
      messages: [{ role: 'user', content: 'hi' }],
      scope: { types: ['carrier-pigeon'] },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-string scope.docId', async () => {
    const errors = await errorsFor({
      messages: [{ role: 'user', content: 'hi' }],
      scope: { docId: 123 },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an empty scope.docId — it would silently widen a "this document" ask to the whole corpus', async () => {
    const errors = await errorsFor({
      messages: [{ role: 'user', content: 'hi' }],
      scope: { docId: '' },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).toContain('docId');
  });

  it('rejects an empty messages array', async () => {
    const errors = await errorsFor({ messages: [] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a message content over 4000 chars', async () => {
    const errors = await errorsFor({ messages: [{ role: 'user', content: 'a'.repeat(4001) }] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an unrecognized turn role', async () => {
    const errors = await errorsFor({ messages: [{ role: 'system', content: 'hi' }] });
    expect(errors.length).toBeGreaterThan(0);
  });
});
