import { describe, it, expect } from 'vitest';
import { composeUrlForGroup } from './groupCompose';
import { MAX_EXPANDED_MEMBERS } from './groupRecipients';

describe('composeUrlForGroup', () => {
  it('puts de-duplicated member addresses in the to parameter', () => {
    const url = composeUrlForGroup([
      { email: 'a@risa.gov.rw' },
      { email: 'A@RISA.GOV.RW' },
      { email: '  ' },
      { email: 'b@risa.gov.rw' },
    ]);
    expect(url).toBe('/mail?compose=1&to=a%40risa.gov.rw%2Cb%40risa.gov.rw');
  });

  it('caps at MAX_EXPANDED_MEMBERS addresses, keeping the first occurrences in order', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ email: `u${i}@risa.gov.rw` }));
    const url = composeUrlForGroup(many);
    const to = decodeURIComponent(url).split('to=')[1].split(',');
    expect(to).toHaveLength(MAX_EXPANDED_MEMBERS);
    expect(to[0]).toBe('u0@risa.gov.rw');
    expect(to[to.length - 1]).toBe('u49@risa.gov.rw');
    expect(to).not.toContain('u50@risa.gov.rw');
  });

  it('returns a plain compose url for an empty group', () => {
    expect(composeUrlForGroup([])).toBe('/mail?compose=1');
  });

  it('returns a plain compose url when every member email is blank', () => {
    expect(composeUrlForGroup([{ email: '' }, { email: '   ' }])).toBe('/mail?compose=1');
  });
});
