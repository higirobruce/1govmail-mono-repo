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

  /**
   * F3. A thread scope's scopeId is the seed message id, which on Exchange is
   * the raw EWS ItemId — a base64 store id routinely 140-200+ characters. At
   * @MaxLength(200) that 400s, and the panel's persist swallows the failure by
   * design: thread-scoped history would silently never save on the Exchange
   * VM while looking perfect on Zimbra. No other message-id path in this API
   * imposes a cap (snooze-message.dto, agent.dto, Commitment.messageId).
   */
  it('accepts a full-length EWS ItemId as scopeId', async () => {
    const ewsItemId = `AAMkAG${'Qw9/+Ab'.repeat(40)}=`; // 286 chars, base64 store id shape
    expect(ewsItemId.length).toBeGreaterThan(200);
    const errors = await errorsFor({
      scopeKind: 'thread', scopeId: ewsItemId, scopeLabel: 'Re: RHEMIS inception report',
      model: 'qwen3', turns: TWO_TURNS,
    });
    expect(errors).toHaveLength(0);
  });

  /**
   * F3, same silent-failure shape: a long subject must not cost the whole
   * write. The service truncates scopeLabel instead of rejecting on it.
   */
  it('accepts a subject far longer than the stored label', async () => {
    const errors = await errorsFor({
      scopeKind: 'thread', scopeId: 'm1', scopeLabel: 'S'.repeat(900),
      model: 'qwen3', turns: TWO_TURNS,
    });
    expect(errors).toHaveLength(0);
  });

  /**
   * F5. `content` carried no cap at all, so the only bound on a row was the
   * 50 MB body limit: one authenticated user could persist arbitrarily large
   * rows, kept 90 days, on the 78%-disk box. The cap is an abuse bound, well
   * past any real answer (which the service also truncates, so a long answer
   * still saves rather than 400ing).
   */
  it('accepts an answer longer than anything a model really produces', async () => {
    const errors = await errorsFor({
      scopeKind: 'app', model: 'qwen3',
      turns: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a'.repeat(40_000) }],
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects content past the abuse bound', async () => {
    const errors = await errorsFor({
      scopeKind: 'app', model: 'qwen3',
      turns: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a'.repeat(100_001) }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
