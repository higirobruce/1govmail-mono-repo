import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OfflineDB } from './db';
import { MailCache } from './mailCache';

function fixedClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

describe('MailCache', () => {
  let db: OfflineDB;

  beforeEach(async () => {
    db = new OfflineDB(`mailcache-${crypto.randomUUID()}`);
    await db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips a folder page', async () => {
    const clock = fixedClock();
    const cache = new MailCache(db, { now: clock.now });
    await cache.setFolderPage('inbox', { messages: [{ id: 'a' }], hasMore: false, total: 1 });

    const got = await cache.getFolderPage('inbox');
    expect(got).toBeDefined();
    expect(got!.folderId).toBe('inbox');
    expect(got!.fetchedAt).toBe(1_000_000);
    expect(got!.data).toEqual({ messages: [{ id: 'a' }], hasMore: false, total: 1 });
  });

  it('overwrites an existing folder page on set', async () => {
    const clock = fixedClock(0);
    const cache = new MailCache(db, { now: clock.now });

    clock.set(100);
    await cache.setFolderPage('inbox', { v: 1 });
    clock.set(500);
    await cache.setFolderPage('inbox', { v: 2 });

    const got = await cache.getFolderPage('inbox');
    expect(got!.data).toEqual({ v: 2 });
    expect(got!.fetchedAt).toBe(500);
  });

  it('returns undefined for an unknown folder', async () => {
    const cache = new MailCache(db);
    expect(await cache.getFolderPage('nope')).toBeUndefined();
  });

  it('round-trips a message and bumps lastAccessedAt on read', async () => {
    const clock = fixedClock(1_000);
    const cache = new MailCache(db, { now: clock.now });

    await cache.setMessage('m1', { subject: 'hi' });
    let row = await cache.getMessage('m1');
    expect(row!.data).toEqual({ subject: 'hi' });
    expect(row!.fetchedAt).toBe(1_000);

    clock.set(5_000);
    row = await cache.getMessage('m1');
    expect(row!.lastAccessedAt).toBe(5_000);
    expect(row!.fetchedAt).toBe(1_000);
  });

  it('returns undefined for an unknown message', async () => {
    const cache = new MailCache(db);
    expect(await cache.getMessage('nope')).toBeUndefined();
  });

  it('evicts the oldest messages by lastAccessedAt when over the cap', async () => {
    const clock = fixedClock(0);
    const cache = new MailCache(db, { now: clock.now });

    for (let i = 1; i <= 5; i++) {
      clock.set(i * 100);
      await cache.setMessage(`m${i}`, { i });
    }

    clock.set(1_000);
    await cache.getMessage('m1');

    const removed = await cache.evictOldMessages(3);
    expect(removed).toBe(2);

    const remaining = (await db.messages.toArray()).map((r) => r.id).sort();
    expect(remaining).toEqual(['m1', 'm4', 'm5']);
  });

  it('evictOldMessages is a no-op below the cap', async () => {
    const cache = new MailCache(db);
    await cache.setMessage('m1', {});
    await cache.setMessage('m2', {});
    expect(await cache.evictOldMessages(10)).toBe(0);
  });

  it('clear empties both tables', async () => {
    const cache = new MailCache(db);
    await cache.setFolderPage('a', {});
    await cache.setMessage('m1', {});

    await cache.clear();

    expect(await cache.getFolderPage('a')).toBeUndefined();
    expect(await cache.getMessage('m1')).toBeUndefined();
  });
});
