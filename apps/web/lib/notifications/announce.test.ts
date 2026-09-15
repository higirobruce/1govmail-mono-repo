import { describe, it, expect, beforeEach } from 'vitest';
import {
  AUDIBLE_TYPES, isAudible, selectNewNotifications, newestCreatedAt, claimAnnouncement,
} from './announce';

const row = (id: string, createdAt: string, type = 'NEW_MAIL') => ({ id, type, title: id, createdAt });

describe('isAudible', () => {
  it('is true for exactly new mail and calendar reminders', () => {
    expect(AUDIBLE_TYPES).toEqual(['NEW_MAIL', 'EVENT_SOON']);
    expect(isAudible('NEW_MAIL')).toBe(true);
    expect(isAudible('EVENT_SOON')).toBe(true);
  });

  it('is false for the types that must stay silent', () => {
    expect(isAudible('TASK_DUE')).toBe(false);
    expect(isAudible('MAIL_SNOOZE_EXPIRED')).toBe(false);
    expect(isAudible('SCHEDULED_SENT')).toBe(false);
  });
});

describe('selectNewNotifications', () => {
  const feed = [
    row('c', '2026-09-15T10:02:00.000Z'),
    row('b', '2026-09-15T10:01:00.000Z'),
    row('a', '2026-09-15T10:00:00.000Z'),
  ];

  it('announces nothing while the marker is null — a backlog must not play on login', () => {
    // A null marker means exactly one thing: this device has never completed a
    // poll, so everything in the feed is history. The caller records a marker
    // in the same pass — the newest row's createdAt, or its own clock on an
    // empty feed — so a null marker cannot survive a poll and this can only
    // ever suppress a genuine backlog.
    expect(selectNewNotifications(feed, null)).toEqual([]);
    expect(selectNewNotifications([], null)).toEqual([]);
  });

  it('returns only rows newer than the marker, oldest first', () => {
    const picked = selectNewNotifications(feed, '2026-09-15T10:00:00.000Z');
    expect(picked.map((n) => n.id)).toEqual(['b', 'c']);
  });

  it('returns nothing when the feed has not moved', () => {
    expect(selectNewNotifications(feed, '2026-09-15T10:02:00.000Z')).toEqual([]);
  });

  it('is unbothered by a feed that arrives out of order', () => {
    const shuffled = [feed[1], feed[2], feed[0]];
    const picked = selectNewNotifications(shuffled, '2026-09-15T10:00:00.000Z');
    expect(picked.map((n) => n.id)).toEqual(['b', 'c']);
  });
});

describe('newestCreatedAt', () => {
  it('finds the newest timestamp regardless of order', () => {
    expect(newestCreatedAt([row('a', '2026-09-15T10:00:00.000Z'), row('b', '2026-09-15T10:05:00.000Z')]))
      .toBe('2026-09-15T10:05:00.000Z');
  });

  it('is null for an empty feed', () => {
    expect(newestCreatedAt([])).toBeNull();
  });
});

describe('claimAnnouncement', () => {
  beforeEach(() => localStorage.clear());

  it('lets the first caller announce and refuses the second — one chime, not one per tab', () => {
    expect(claimAnnouncement('n1')).toBe(true);
    expect(claimAnnouncement('n1')).toBe(false);
  });

  it('claims different notifications independently', () => {
    expect(claimAnnouncement('n1')).toBe(true);
    expect(claimAnnouncement('n2')).toBe(true);
  });

  it('forgets stale claims so localStorage cannot grow without bound', () => {
    const old = Date.now() - 25 * 60 * 60 * 1000;
    localStorage.setItem('1gov-announced:old', String(old));
    claimAnnouncement('n1');
    expect(localStorage.getItem('1gov-announced:old')).toBeNull();
  });
});
