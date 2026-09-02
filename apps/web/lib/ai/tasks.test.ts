import { describe, it, expect } from 'vitest';
import type { AIClient, ChatOptions } from './client';
import { rewriteText, suggestReply, summarizeMessage } from './tasks';
import { UNTRUSTED_CONTENT_RULE } from './prompt';

/** Captures the request instead of calling the network; returns a canned reply. */
class FakeClient {
  lastOpts: ChatOptions | null = null;

  async chatStream(opts: ChatOptions, onChunk: (delta: string) => void): Promise<string> {
    this.lastOpts = opts;
    onChunk('ok');
    return 'ok';
  }
}

function systemPrompt(fake: FakeClient): string {
  const sys = fake.lastOpts?.messages.find((m) => m.role === 'system');
  if (!sys) throw new Error('no system message captured');
  return sys.content;
}

const PREFS = 'Always keep replies under two sentences.';

describe('custom instructions wiring', () => {
  it('summarizeMessage appends them after the base rules', async () => {
    const fake = new FakeClient();
    await summarizeMessage(
      fake as unknown as AIClient,
      '<p>Please send the quarterly report by Friday.</p>',
      { model: 'test', customInstructions: PREFS },
      () => {},
    );
    const sys = systemPrompt(fake);
    expect(sys).toContain(PREFS);
    expect(sys.indexOf(UNTRUSTED_CONTENT_RULE)).toBeLessThan(sys.indexOf(PREFS));
  });

  it('summarizeMessage leaves the prompt unchanged when none are set', async () => {
    const fake = new FakeClient();
    await summarizeMessage(
      fake as unknown as AIClient,
      '<p>Please send the quarterly report by Friday.</p>',
      { model: 'test' },
      () => {},
    );
    expect(systemPrompt(fake)).not.toContain(PREFS);
  });

  it('rewriteText appends them', async () => {
    const fake = new FakeClient();
    await rewriteText(
      fake as unknown as AIClient,
      'we will send it over tomorrow',
      'formal',
      { model: 'test', customInstructions: PREFS },
      () => {},
    );
    expect(systemPrompt(fake)).toContain(PREFS);
  });

  it('suggestReply appends them', async () => {
    const fake = new FakeClient();
    await suggestReply(
      fake as unknown as AIClient,
      '<p>Can you confirm attendance at the workshop next week?</p>',
      { model: 'test', userName: 'Bruce', customInstructions: PREFS },
      () => {},
    );
    expect(systemPrompt(fake)).toContain(PREFS);
  });
});

describe('suggestReply intent and length wiring', () => {
  const EMAIL = '<p>Can you confirm attendance at the workshop next week?</p>';

  async function run(opts: Partial<Parameters<typeof suggestReply>[2]>): Promise<string> {
    const fake = new FakeClient();
    await suggestReply(
      fake as unknown as AIClient,
      EMAIL,
      { model: 'test', userName: 'Bruce', ...opts },
      () => {},
    );
    return systemPrompt(fake);
  }

  it('defaults to auto intent and standard length', async () => {
    const sys = await run({});
    expect(sys).toContain('Judge from the email what response it calls for');
    expect(sys).toContain('2–4 short sentences');
  });

  it('applies the decline intent rule', async () => {
    const sys = await run({ intent: 'decline' });
    expect(sys).toContain('Decline politely and clearly');
    expect(sys).not.toContain('Judge from the email what response it calls for');
  });

  it('applies the request-info intent rule', async () => {
    const sys = await run({ intent: 'request-info' });
    expect(sys).toContain('Ask for the specific information needed');
  });

  it('applies the brief length rule', async () => {
    const sys = await run({ length: 'brief' });
    expect(sys).toContain('1–2 short sentences');
    expect(sys).not.toContain('2–4 short sentences');
  });
});
