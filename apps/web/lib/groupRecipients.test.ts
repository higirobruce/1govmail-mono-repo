import { describe, it, expect } from 'vitest';
import { MAX_EXPANDED_MEMBERS, dedupeMemberEmails } from './groupRecipients';

describe('MAX_EXPANDED_MEMBERS', () => {
  it('is 50', () => {
    expect(MAX_EXPANDED_MEMBERS).toBe(50);
  });
});

describe('dedupeMemberEmails', () => {
  it('drops blank and whitespace-only members', () => {
    expect(
      dedupeMemberEmails([{ email: 'a@risa.gov.rw' }, { email: '  ' }, { email: '' }]),
    ).toEqual(['a@risa.gov.rw']);
  });

  it('trims surrounding whitespace on a kept address', () => {
    expect(dedupeMemberEmails([{ email: '  a@risa.gov.rw  ' }])).toEqual(['a@risa.gov.rw']);
  });

  it('de-duplicates case-insensitively within the member list, keeping the first occurrence', () => {
    expect(
      dedupeMemberEmails([{ email: 'a@risa.gov.rw' }, { email: 'A@RISA.GOV.RW' }]),
    ).toEqual(['a@risa.gov.rw']);
  });

  it('de-duplicates case-insensitively against alreadyPresent', () => {
    expect(
      dedupeMemberEmails(
        [{ email: 'A@risa.gov.rw' }, { email: 'b@risa.gov.rw' }],
        ['a@risa.gov.rw'],
      ),
    ).toEqual(['b@risa.gov.rw']);
  });

  it('preserves member order in the output', () => {
    expect(
      dedupeMemberEmails([
        { email: 'c@risa.gov.rw' },
        { email: 'a@risa.gov.rw' },
        { email: 'b@risa.gov.rw' },
      ]),
    ).toEqual(['c@risa.gov.rw', 'a@risa.gov.rw', 'b@risa.gov.rw']);
  });

  it('returns an empty array for empty member input', () => {
    expect(dedupeMemberEmails([])).toEqual([]);
  });

  it('defaults alreadyPresent to empty when omitted', () => {
    expect(dedupeMemberEmails([{ email: 'a@risa.gov.rw' }])).toEqual(['a@risa.gov.rw']);
  });
});
