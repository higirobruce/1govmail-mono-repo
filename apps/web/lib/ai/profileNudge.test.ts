import { describe, it, expect } from 'vitest';
import { shouldShowAiProfileNudge } from './profileNudge';

const empty = { jobTitle: null, institution: null, department: null, instructions: null };

describe('shouldShowAiProfileNudge', () => {
  it('prompts when the profile is completely empty', () => {
    expect(shouldShowAiProfileNudge(empty, false)).toBe(true);
  });

  it('stays quiet once any identifying field is filled', () => {
    expect(shouldShowAiProfileNudge({ ...empty, jobTitle: 'Director of ICT' }, false)).toBe(false);
    expect(shouldShowAiProfileNudge({ ...empty, institution: 'RISA' }, false)).toBe(false);
    expect(shouldShowAiProfileNudge({ ...empty, department: 'Software' }, false)).toBe(false);
    expect(shouldShowAiProfileNudge({ ...empty, instructions: 'Reply briefly' }, false)).toBe(false);
  });

  it('ignores language, which gets set automatically and says nothing about the user', () => {
    expect(shouldShowAiProfileNudge({ ...empty, language: 'rw' }, false)).toBe(true);
  });

  it('treats whitespace as empty', () => {
    expect(shouldShowAiProfileNudge({ ...empty, jobTitle: '   ' }, false)).toBe(true);
  });

  it('stays quiet forever once dismissed', () => {
    expect(shouldShowAiProfileNudge(empty, true)).toBe(false);
  });

  it('stays quiet while the profile has not loaded yet, rather than flashing', () => {
    // An un-loaded profile is indistinguishable from an empty one; showing the
    // nudge on every page load until the fetch lands is the flicker bug this
    // avoids.
    expect(shouldShowAiProfileNudge(null, false)).toBe(false);
    expect(shouldShowAiProfileNudge(undefined, false)).toBe(false);
  });
});
