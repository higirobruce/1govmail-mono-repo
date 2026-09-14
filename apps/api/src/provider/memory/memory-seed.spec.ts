import { seedMailbox } from './memory-seed';

const NOW = 1757500000000; // fixed instant
const now = () => NOW;

describe('seedMailbox', () => {
  const mb = seedMailbox('demo@memory.local', 'pw', now);

  it('creates the five standard folders with correct kinds and counts', () => {
    const names = mb.folders.map((f) => f.name).sort();
    expect(names).toEqual(['Drafts', 'Inbox', 'Junk', 'Sent', 'Trash']);
    const inbox = mb.folders.find((f) => f.name === 'Inbox')!;
    expect(inbox.type).toBe('inbox');
    expect(inbox.kind).toBe('mail');
    // unread count equals the number of unread inbox messages
    const inboxMsgs = mb.messages.filter((m) => m.folderId === inbox.id);
    expect(inbox.totalCount).toBe(inboxMsgs.length);
    expect(inbox.unreadCount).toBe(inboxMsgs.filter((m) => !m.isRead).length);
  });

  it('seeds ~30 messages across a few threads, some unread, some flagged, one with an attachment', () => {
    expect(mb.messages.length).toBeGreaterThanOrEqual(25);
    expect(mb.messages.some((m) => !m.isRead)).toBe(true);
    expect(mb.messages.some((m) => m.isFlagged)).toBe(true);
    expect(mb.messages.some((m) => m.hasAttachments)).toBe(true);
    // threads: at least one conversationId shared by >1 message
    const byConv = new Map<string, number>();
    for (const m of mb.messages) if (m.conversationId) byConv.set(m.conversationId, (byConv.get(m.conversationId) ?? 0) + 1);
    expect([...byConv.values()].some((n) => n > 1)).toBe(true);
  });

  it('is deterministic — same inputs give identical ids and order', () => {
    const a = seedMailbox('demo@memory.local', 'pw', now);
    const b = seedMailbox('demo@memory.local', 'pw', now);
    expect(a.messages.map((m) => m.id)).toEqual(b.messages.map((m) => m.id));
  });

  it('seeds ~10 contacts and ~5 events in the current week relative to now', () => {
    expect(mb.contacts.length).toBeGreaterThanOrEqual(8);
    expect(mb.events.length).toBeGreaterThanOrEqual(4);
    const weekMs = 7 * 24 * 3600 * 1000;
    expect(mb.events.every((e) => Math.abs(e.startAt.getTime() - NOW) <= weekMs)).toBe(true);
  });

  it('provides all-true settings surface (identities, signatures, prefs)', () => {
    expect(mb.identities.length).toBeGreaterThanOrEqual(1);
    expect(mb.signatures.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(mb.prefs).length).toBeGreaterThan(0);
  });
});
