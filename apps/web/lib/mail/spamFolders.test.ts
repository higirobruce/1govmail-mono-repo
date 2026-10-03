import { describe, it, expect } from 'vitest';
import { SPAM_FOLDER_PATHS, isSpamFolderPath } from '@email-client/shared';

/**
 * The spam folder has two possible paths depending on the Zimbra deployment.
 * The API enforces sender rules against that set and the web decides where to
 * offer "Not spam" from it, so the two MUST agree — hence one definition in
 * the shared package rather than a copy on each side.
 */
describe('isSpamFolderPath', () => {
  it('recognises both deployment spellings of the spam folder', () => {
    expect(isSpamFolderPath('/Junk')).toBe(true);
    expect(isSpamFolderPath('/Spam')).toBe(true);
  });

  it('rejects every other folder, including ones that merely contain the word', () => {
    expect(isSpamFolderPath('/Inbox')).toBe(false);
    expect(isSpamFolderPath('/Trash')).toBe(false);
    expect(isSpamFolderPath('/Junk drawer')).toBe(false);
    expect(isSpamFolderPath('')).toBe(false);
  });

  it('tolerates a missing path rather than throwing', () => {
    expect(isSpamFolderPath(undefined)).toBe(false);
    expect(isSpamFolderPath(null)).toBe(false);
  });

  it('exposes the paths themselves for callers that need the list', () => {
    expect([...SPAM_FOLDER_PATHS]).toEqual(['/Junk', '/Spam']);
  });
});
