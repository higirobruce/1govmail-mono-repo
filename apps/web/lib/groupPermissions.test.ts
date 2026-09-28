import { describe, it, expect } from 'vitest';
import { isGroupOwner, canEditGroup, type PermissionedGroup } from './groupPermissions';

const OWNER_ID = 'user-owner';
const EDITOR_EMAIL = 'alice@risa.gov.rw';
const VIEWER_EMAIL = 'bob@risa.gov.rw';

const group: PermissionedGroup = {
  userId: OWNER_ID,
  invites: [
    { id: 'inv-1', invitedEmail: EDITOR_EMAIL, role: 'EDITOR' },
    { id: 'inv-2', invitedEmail: VIEWER_EMAIL, role: 'VIEWER' },
  ],
};

describe('isGroupOwner', () => {
  it('is true when the group userId matches the current user', () => {
    expect(isGroupOwner(group, OWNER_ID)).toBe(true);
  });

  it('is false when the group userId does not match the current user', () => {
    expect(isGroupOwner(group, 'someone-else')).toBe(false);
  });

  it('fails closed when currentUserId is missing', () => {
    expect(isGroupOwner(group, undefined)).toBe(false);
    expect(isGroupOwner(group, null)).toBe(false);
  });

  it('fails closed when the group is null', () => {
    expect(isGroupOwner(null, OWNER_ID)).toBe(false);
  });
});

describe('canEditGroup', () => {
  it('owner can edit', () => {
    expect(canEditGroup(group, OWNER_ID, 'owner@risa.gov.rw')).toBe(true);
  });

  it('the caller who IS the EDITOR invitee can edit', () => {
    expect(canEditGroup(group, 'some-other-user-id', EDITOR_EMAIL)).toBe(true);
  });

  it('regression: a VIEWER cannot edit merely because a DIFFERENT person on the group is an EDITOR', () => {
    // Bob is a VIEWER; Alice (a different invitee) is EDITOR. Bob must not
    // be granted edit rights just because someone else's invite row says EDITOR.
    expect(canEditGroup(group, 'bobs-user-id', VIEWER_EMAIL)).toBe(false);
  });

  it('matches the caller\'s own invite case-insensitively', () => {
    expect(canEditGroup(group, 'some-other-user-id', 'Alice@RISA.GOV.RW')).toBe(true);
  });

  it('cannot edit when there is no current user email', () => {
    expect(canEditGroup(group, 'some-other-user-id', undefined)).toBe(false);
    expect(canEditGroup(group, 'some-other-user-id', null)).toBe(false);
    expect(canEditGroup(group, 'some-other-user-id', '')).toBe(false);
  });

  it('isGroupOwner check inside canEditGroup: mismatched userId with no matching invite is false', () => {
    expect(canEditGroup(group, 'not-the-owner', 'stranger@risa.gov.rw')).toBe(false);
  });
});
