import { describe, it, expect } from 'vitest';
import { deriveLabel } from '@email-client/shared';

const base = { asksOfMe: [] as string[], waitingOn: null as string | null, deadlines: [] as string[] };

describe('deriveLabel priority order', () => {
  it('needsDecision beats everything', () => {
    expect(deriveLabel({ ...base, asksOfMe: ['approve'], waitingOn: 'x', deadlines: ['Fri'] })).toBe('needsDecision');
  });
  it('waitingOnYou beats deadline', () => {
    expect(deriveLabel({ ...base, waitingOn: 'signature', deadlines: ['Fri'] })).toBe('waitingOnYou');
  });
  it('deadline when only dated', () => {
    expect(deriveLabel({ ...base, deadlines: ['Fri'] })).toBe('deadline');
  });
  it('fyi otherwise', () => {
    expect(deriveLabel(base)).toBe('fyi');
  });
});
