import { buildAgentPrompt, UNTRUSTED_CONTENT_RULE } from '@email-client/shared';

describe('buildAgentPrompt', () => {
  const prompt = buildAgentPrompt({
    userEmail: 'bruce.higiro@risa.gov.rw',
    userName: 'Bruce',
    nowIso: '2026-09-06T10:00:00.000Z',
  });

  it('leads with the untrusted-content rule', () => {
    expect(prompt.indexOf(UNTRUSTED_CONTENT_RULE)).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf(UNTRUSTED_CONTENT_RULE)).toBeLessThan(prompt.indexOf('MANDATES'));
  });

  it('includes identity, date and proposal mandate', () => {
    expect(prompt).toContain('bruce.higiro@risa.gov.rw');
    expect(prompt).toContain('2026-09-06T10:00:00.000Z');
    expect(prompt).toContain('send_email');
    expect(prompt).toContain('approve');
  });

  it('handles null userName', () => {
    const p = buildAgentPrompt({ userEmail: 'x@y.rw', userName: null, nowIso: 'now' });
    expect(p).toContain('the user <x@y.rw>');
  });
});
