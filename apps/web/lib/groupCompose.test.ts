import { describe, it, expect } from 'vitest';
import { composeUrlForGroup } from './groupCompose';
import { MAX_EXPANDED_MEMBERS } from './groupRecipients';

describe('composeUrlForGroup', () => {
  it('puts de-duplicated member addresses in the to parameter', () => {
    const { url, omitted } = composeUrlForGroup([
      { email: 'a@risa.gov.rw' },
      { email: 'A@RISA.GOV.RW' },
      { email: '  ' },
      { email: 'b@risa.gov.rw' },
    ]);
    expect(url).toBe('/mail?compose=1&to=a%40risa.gov.rw%2Cb%40risa.gov.rw');
    expect(omitted).toBe(0);
  });

  it('caps at MAX_EXPANDED_MEMBERS addresses, keeping the first occurrences in order, and reports the omitted count', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ email: `u${i}@risa.gov.rw` }));
    const { url, omitted } = composeUrlForGroup(many);
    const to = decodeURIComponent(url).split('to=')[1].split(',');
    expect(to).toHaveLength(MAX_EXPANDED_MEMBERS);
    expect(to[0]).toBe('u0@risa.gov.rw');
    expect(to[to.length - 1]).toBe('u49@risa.gov.rw');
    expect(to).not.toContain('u50@risa.gov.rw');
    expect(omitted).toBe(10);
  });

  it('reports omitted as 0 when the group is under the cap', () => {
    const under = Array.from({ length: 12 }, (_, i) => ({ email: `u${i}@risa.gov.rw` }));
    const { omitted } = composeUrlForGroup(under);
    expect(omitted).toBe(0);
  });

  it('returns a plain compose url for an empty group', () => {
    const { url, omitted } = composeUrlForGroup([]);
    expect(url).toBe('/mail?compose=1');
    expect(omitted).toBe(0);
  });

  it('returns a plain compose url when every member email is blank', () => {
    const { url, omitted } = composeUrlForGroup([{ email: '' }, { email: '   ' }]);
    expect(url).toBe('/mail?compose=1');
    expect(omitted).toBe(0);
  });
});
