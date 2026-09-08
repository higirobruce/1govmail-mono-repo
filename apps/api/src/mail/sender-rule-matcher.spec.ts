import { matchSenderRule, type SenderRuleLike } from './sender-rule-matcher';

describe('matchSenderRule', () => {
  it('returns null when no rules match', () => {
    expect(matchSenderRule('a@example.com', [])).toBeNull();
  });

  it('matches an exact blocked address', () => {
    const rules: SenderRuleLike[] = [{ type: 'BLOCK', address: 'spam@evil.com' }];
    expect(matchSenderRule('spam@evil.com', rules)).toBe('BLOCK');
  });

  it('matches a blocked domain wildcard', () => {
    const rules: SenderRuleLike[] = [{ type: 'BLOCK', address: '@evil.com' }];
    expect(matchSenderRule('anyone@evil.com', rules)).toBe('BLOCK');
  });

  it('is case-insensitive', () => {
    const rules: SenderRuleLike[] = [{ type: 'BLOCK', address: 'Spam@Evil.com' }];
    expect(matchSenderRule('spam@evil.com', rules)).toBe('BLOCK');
  });

  it('lets an exact ALLOW override a domain BLOCK', () => {
    const rules: SenderRuleLike[] = [
      { type: 'BLOCK', address: '@evil.com' },
      { type: 'ALLOW', address: 'trusted@evil.com' },
    ];
    expect(matchSenderRule('trusted@evil.com', rules)).toBe('ALLOW');
    expect(matchSenderRule('other@evil.com', rules)).toBe('BLOCK');
  });

  it('does not match unrelated domains', () => {
    const rules: SenderRuleLike[] = [{ type: 'BLOCK', address: '@evil.com' }];
    expect(matchSenderRule('person@good.com', rules)).toBeNull();
  });
});
