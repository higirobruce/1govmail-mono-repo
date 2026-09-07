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

  it('includes the probe-first clarification mandate', () => {
    expect(prompt).toContain('ask_user');
    expect(prompt).toMatch(/search(?:ing)? first/i);
    expect(prompt).toMatch(/at most one|once per turn/i);
  });

  it('forbids plain-text clarifying questions — they must go through ask_user', () => {
    expect(prompt).toMatch(/never ask (?:the user )?(?:a clarifying question |for clarification )?in plain text/i);
  });

  it('handles null userName', () => {
    const p = buildAgentPrompt({ userEmail: 'x@y.rw', userName: null, nowIso: 'now' });
    expect(p).toContain('the user <x@y.rw>');
  });
});
