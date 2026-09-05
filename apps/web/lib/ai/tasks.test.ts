import { describe, it, expect } from 'vitest';
import type { AIClient, ChatOptions } from './client';
import { formatMinutes, rewriteText, suggestReply, summarizeMessage } from './tasks';
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

describe('formatMinutes', () => {
  function userPrompt(fake: FakeClient): string {
    const user = fake.lastOpts?.messages.find((m) => m.role === 'user');
    if (!user) throw new Error('no user message captured');
    return user.content;
  }

  it('mentions the four sections in order and forbids invention', async () => {
    const fake = new FakeClient();
    await formatMinutes(
      fake as unknown as AIClient,
      'Bruce and Alice met to discuss the rollout. Bruce will send the report by Friday.',
      { model: 'test' },
      () => {},
    );
    const sys = systemPrompt(fake);
    const order = ['Attendees', 'Agenda', 'Decisions', 'Action items'];
    let lastIndex = -1;
    for (const section of order) {
      const idx = sys.indexOf(section);
      expect(idx).toBeGreaterThan(-1);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
    expect(sys.toLowerCase()).toContain('never invent names, decisions, or dates');
    expect(sys).toContain(UNTRUSTED_CONTENT_RULE);
  });

  it('truncates the notes to 8000 chars in the user prompt', async () => {
    const fake = new FakeClient();
    const notes = 'x'.repeat(9000);
    await formatMinutes(fake as unknown as AIClient, notes, { model: 'test' }, () => {});
    const user = userPrompt(fake);
    expect(user).toContain('[…truncated]');
    // The fenced body should hold no more than the 8000-char cap (plus the marker).
    const bodyMatch = /<<<NOTES:[0-9a-f]+\n([\s\S]*?)\nNOTES:[0-9a-f]+>>>/.exec(user);
    expect(bodyMatch).not.toBeNull();
    expect(bodyMatch![1].length).toBeLessThanOrEqual(8000 + '\n\n[…truncated]'.length);
  });

  it('returns empty string for empty input without calling the client', async () => {
    const fake = new FakeClient();
    let called = false;
    const originalChatStream = fake.chatStream.bind(fake);
    fake.chatStream = async (...args) => {
      called = true;
      return originalChatStream(...args);
    };
    const result = await formatMinutes(fake as unknown as AIClient, '   ', { model: 'test' }, () => {});
    expect(result).toBe('');
    expect(called).toBe(false);
  });

  it('passes the completion through scrubOutput', async () => {
    class LeakyClient {
      async chatStream(_opts: ChatOptions, onChunk: (delta: string) => void): Promise<string> {
        const leaked = '<<<NOTES:ab12cd34ef\n## Decisions\n- Ship on Friday.\nNOTES:ab12cd34ef>>>';
        onChunk(leaked);
        return leaked;
      }
    }
    const result = await formatMinutes(
      new LeakyClient() as unknown as AIClient,
      'Ship on Friday, everyone agreed.',
      { model: 'test' },
      () => {},
    );
    expect(result).toBe('## Decisions\n- Ship on Friday.');
  });

  it('passes subject and custom instructions through like summarizeSelection', async () => {
    const fake = new FakeClient();
    await formatMinutes(
      fake as unknown as AIClient,
      'Bruce and Alice discussed the rollout plan.',
      { model: 'test', subject: 'Weekly sync', customInstructions: PREFS },
      () => {},
    );
    expect(userPrompt(fake)).toContain('Document: Weekly sync');
    expect(systemPrompt(fake)).toContain(PREFS);
  });
});
