import 'reflect-metadata'; // ValidateNested/@Type decorators need Reflect.getMetadata — normally polyfilled by main.ts at boot
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateConversationDto } from './conversations.dto';

// Mirrors main.ts's global `new ValidationPipe({ whitelist: true, transform: true })` —
// a rejected `validate()` here is exactly what becomes a 400 at the HTTP layer.
async function errorsFor(body: unknown) {
  const dto = plainToInstance(CreateConversationDto, body);
  return validate(dto, { whitelist: true });
}

const TWO_TURNS = [
  { role: 'user', content: 'q' },
  { role: 'assistant', content: 'a' },
];

describe('CreateConversationDto', () => {
  it('accepts a normal conversation', async () => {
    const errors = await errorsFor({ scopeKind: 'app', model: 'qwen3', turns: TWO_TURNS });
    expect(errors).toHaveLength(0);
  });

  it('accepts a turn with exactly 50 sources', async () => {
    const errors = await errorsFor({
      scopeKind: 'app',
      model: 'qwen3',
      turns: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', sources: Array.from({ length: 50 }, (_, i) => ({ id: i })) },
      ],
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects a turn with more than 50 sources — unbounded sources is exactly the storage-estimate defeater', async () => {
    const errors = await errorsFor({
      scopeKind: 'app',
      model: 'qwen3',
      turns: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', sources: Array.from({ length: 51 }, (_, i) => ({ id: i })) },
      ],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a turn with more than 50 steps', async () => {
    const errors = await errorsFor({
      scopeKind: 'app',
      model: 'qwen3',
      turns: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', steps: Array.from({ length: 51 }, (_, i) => ({ i })) },
      ],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a turn with more than 50 proposals', async () => {
    const errors = await errorsFor({
      scopeKind: 'app',
      model: 'qwen3',
      turns: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', proposals: Array.from({ length: 51 }, (_, i) => ({ i })) },
      ],
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
