import { describe, it, expect } from 'vitest';
import { isSentLikeFolderPath } from '@email-client/shared';

/**
 * The folders where the sender is always the user, so a "From" column tells the
 * reader nothing and the addressee has to take its place (Zimbra's behaviour).
 * Lives beside isSpamFolderPath because it answers the same kind of question
 * about the same path strings.
 */
describe('isSentLikeFolderPath', () => {
  it('recognises the folders whose rows should name the addressee', () => {
    expect(isSentLikeFolderPath('/Sent')).toBe(true);
    expect(isSentLikeFolderPath('/Drafts')).toBe(true);
    expect(isSentLikeFolderPath('/Outbox')).toBe(true);
  });

  it('rejects folders that receive mail from other people', () => {
    expect(isSentLikeFolderPath('/Inbox')).toBe(false);
    expect(isSentLikeFolderPath('/Trash')).toBe(false);
    expect(isSentLikeFolderPath('/Archive')).toBe(false);
    expect(isSentLikeFolderPath('/Junk')).toBe(false);
  });

  it('does not match a user folder that merely starts with a sent-like name', () => {
    // "/Sent items 2024" is someone's own archive folder of received mail —
    // a prefix match would silently relabel its rows.
    expect(isSentLikeFolderPath('/Sent items 2024')).toBe(false);
    expect(isSentLikeFolderPath('/Drafts old')).toBe(false);
  });

  it('tolerates a missing path', () => {
    expect(isSentLikeFolderPath(undefined)).toBe(false);
    expect(isSentLikeFolderPath(null)).toBe(false);
    expect(isSentLikeFolderPath('')).toBe(false);
  });
});
