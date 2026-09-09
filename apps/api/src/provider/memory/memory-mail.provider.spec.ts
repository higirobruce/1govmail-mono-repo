import { MemoryMailProvider } from './memory-mail.provider';
import { MemoryStore } from './memory-store';
import { UnauthorizedException, NotFoundException } from '@nestjs/common';
import { MailProvider } from '../mail-provider.interface';

const NOW = 1757500000000;
function setup() {
  const store = new MemoryStore(() => NOW);
  const provider = new MemoryMailProvider(store);
  return { store, provider };
}
const sessionFor = (email: string) => ({ host: 'memory.local', email, authToken: 'memtok' });

describe('MemoryMailProvider — auth + reads', () => {
  it('authenticate seeds on first login, accepts any password, returns a token + displayName, never 2FA', async () => {
    const { store, provider } = setup();
    const res = await provider.authenticate('memory.local', 'demo@memory.local', 'anything');
    expect(res.authToken).toBeTruthy();
    expect(res.twoFactorRequired).toBe(false);
    expect(res.lifetime).toBeGreaterThan(0);
    expect(store.has('demo@memory.local')).toBe(true);
  });

  it('name and capabilities', () => {
    const { provider } = setup();
    expect(provider.name).toBe('memory');
    expect(provider.capabilities).toEqual({ signatures: true, identities: true, serverPrefs: true, changePassword: true, twoFactor: true });
  });

  it('getFolders returns the seeded folders; unauthenticated session throws', async () => {
    const { provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const folders = await provider.getFolders(sessionFor('demo@memory.local'));
    expect(folders.map((f) => f.name)).toContain('Inbox');
    await expect(provider.getFolders(sessionFor('nobody@memory.local'))).rejects.toThrow(UnauthorizedException);
  });

  it('getMessages paginates inbox by receivedAt desc with correct total/more', async () => {
    const { provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const inbox = (await provider.getFolders(sessionFor('demo@memory.local'))).find((f) => f.type === 'inbox')!;
    const page1 = await provider.getMessages(sessionFor('demo@memory.local'), inbox.id, 5, 0);
    expect(page1.messages.length).toBe(5);
    expect(page1.total).toBeGreaterThan(5);
    expect(page1.more).toBe(true);
    // sorted desc
    const ts = page1.messages.map((m) => m.receivedAt.getTime());
    expect(ts).toEqual([...ts].sort((a, b) => b - a));
  });

  it('getMessage returns a full body; searchMessages substring-matches subject/from/body', async () => {
    const { provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const inbox = (await provider.getFolders(sessionFor('demo@memory.local'))).find((f) => f.type === 'inbox')!;
    const first = (await provider.getMessages(sessionFor('demo@memory.local'), inbox.id, 1, 0)).messages[0];
    const full = await provider.getMessage(sessionFor('demo@memory.local'), first.id);
    expect(full.bodyHtml ?? full.bodyText).toBeTruthy();
    const hits = await provider.searchMessages(sessionFor('demo@memory.local'), first.subject!.split(' ')[0], 50, 0);
    expect(hits.messages.some((m) => m.id === first.id)).toBe(true);
  });

  it('authenticate is idempotent per email: same mailbox identity, password updates on repeat login', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'pw1');
    const mbAfterFirst = store.get('demo@memory.local')!;
    await provider.authenticate('memory.local', 'demo@memory.local', 'pw2');
    const mbAfterSecond = store.get('demo@memory.local')!;
    expect(mbAfterSecond).toBe(mbAfterFirst);
    expect(mbAfterSecond.password).toBe('pw2');
  });

  it('getMessage on an unknown id rejects with NotFoundException (not Unauthorized)', async () => {
    const { provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    await expect(
      provider.getMessage(sessionFor('demo@memory.local'), 'msg-does-not-exist'),
    ).rejects.toThrow(NotFoundException);
  });

  it('createFolder/renameFolder/emptyFolder/deleteFolder mutate the mailbox', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const created = await provider.createFolder(sessionFor('demo@memory.local'), 'Projects');
    expect(created.name).toBe('Projects');
    expect(created.kind).toBe('mail');

    await provider.renameFolder(sessionFor('demo@memory.local'), created.id, 'Renamed');
    const mbox = store.get('demo@memory.local')!;
    expect(mbox.folders.find((f) => f.id === created.id)!.name).toBe('Renamed');

    const inbox = mbox.folders.find((f) => f.type === 'inbox')!;
    await provider.emptyFolder(sessionFor('demo@memory.local'), inbox.id);
    expect(mbox.messages.some((m) => m.folderId === inbox.id)).toBe(false);

    await provider.deleteFolder(sessionFor('demo@memory.local'), created.id);
    expect(mbox.folders.some((f) => f.id === created.id)).toBe(false);
  });
});

describe('MemoryMailProvider — mutations, send, drafts, attachments', () => {
  it('markRead flips isRead and keeps the folder unreadCount consistent', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const mbox = store.get('demo@memory.local')!;
    const inbox = mbox.folders.find((f) => f.type === 'inbox')!;
    const unreadMsg = mbox.messages.find((m) => m.folderId === inbox.id && !m.isRead)!;
    const before = inbox.unreadCount;

    await provider.markRead(sessionFor('demo@memory.local'), unreadMsg.id, true);
    expect(mbox.messages.find((m) => m.id === unreadMsg.id)!.isRead).toBe(true);
    expect(inbox.unreadCount).toBe(before - 1);

    await provider.markRead(sessionFor('demo@memory.local'), unreadMsg.id, false);
    expect(inbox.unreadCount).toBe(before);
  });

  it('markRead on an unknown id rejects with NotFoundException', async () => {
    const { provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    await expect(
      provider.markRead(sessionFor('demo@memory.local'), 'msg-does-not-exist', true),
    ).rejects.toThrow(NotFoundException);
  });

  it('moveMessage changes folderId and keeps both folders totalCount consistent', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const mbox = store.get('demo@memory.local')!;
    const inbox = mbox.folders.find((f) => f.type === 'inbox')!;
    const junk = mbox.folders.find((f) => f.type === 'junk')!;
    const msg = mbox.messages.find((m) => m.folderId === inbox.id)!;
    const inboxTotalBefore = inbox.totalCount;
    const junkTotalBefore = junk.totalCount;

    await provider.moveMessage(sessionFor('demo@memory.local'), msg.id, junk.id);
    expect(mbox.messages.find((m) => m.id === msg.id)!.folderId).toBe(junk.id);
    expect(inbox.totalCount).toBe(inboxTotalBefore - 1);
    expect(junk.totalCount).toBe(junkTotalBefore + 1);
  });

  it('moveMessage to an unknown folderId rejects with NotFoundException and leaves the message untouched', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const mbox = store.get('demo@memory.local')!;
    const inbox = mbox.folders.find((f) => f.type === 'inbox')!;
    const msg = mbox.messages.find((m) => m.folderId === inbox.id)!;

    await expect(
      provider.moveMessage(sessionFor('demo@memory.local'), msg.id, 'folder-does-not-exist'),
    ).rejects.toThrow(NotFoundException);
    expect(mbox.messages.find((m) => m.id === msg.id)!.folderId).toBe(inbox.id);
  });

  it('deleteMessage soft-deletes by moving the message to Trash', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const mbox = store.get('demo@memory.local')!;
    const inbox = mbox.folders.find((f) => f.type === 'inbox')!;
    const trash = mbox.folders.find((f) => f.type === 'trash')!;
    const msg = mbox.messages.find((m) => m.folderId === inbox.id)!;

    await provider.deleteMessage(sessionFor('demo@memory.local'), msg.id);
    expect(mbox.messages.find((m) => m.id === msg.id)!.folderId).toBe(trash.id);
    expect(mbox.messages.some((m) => m.id === msg.id)).toBe(true); // still exists — soft delete
    expect(trash.totalCount).toBe(1);
  });

  it('sendMessage lands in Sent and delivers to a recipient memory inbox', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    await provider.authenticate('memory.local', 'peer@memory.local', 'x'); // seed the recipient
    const s = { host: 'memory.local', email: 'demo@memory.local', authToken: 't' };
    const { id, conversationId } = await provider.sendMessage(s, { to: ['peer@memory.local'], subject: 'Hi', body: '<p>yo</p>' });
    expect(conversationId).toBeTruthy();
    const sent = store.get('demo@memory.local')!;
    expect(sent.messages.find((m) => m.id === id)!.folderId).toBe(sent.folders.find((f) => f.type === 'sent')!.id);
    expect(sent.messages.find((m) => m.id === id)!.isDraft).toBe(false);
    const peer = store.get('peer@memory.local')!;
    expect(peer.messages.some((m) => m.subject === 'Hi' && m.folderId === peer.folders.find((f) => f.type === 'inbox')!.id)).toBe(true);
  });

  it('sendMessage to a non-memory recipient only lands in Sent (no delivery)', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = { host: 'memory.local', email: 'demo@memory.local', authToken: 't' };
    const { id } = await provider.sendMessage(s, { to: ['nobody@elsewhere.example'], subject: 'Out', body: 'text' });
    const sent = store.get('demo@memory.local')!;
    expect(sent.messages.find((m) => m.id === id)).toBeTruthy();
    expect(store.has('nobody@elsewhere.example')).toBe(false);
  });

  it('saveDraft creates without an id and updates in place with one', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');
    const mbox = store.get('demo@memory.local')!;
    const drafts = mbox.folders.find((f) => f.type === 'drafts')!;

    const draftId = await provider.saveDraft(s, { subject: 'Draft A', body: 'first' });
    const created = mbox.messages.find((m) => m.id === draftId)!;
    expect(created.isDraft).toBe(true);
    expect(created.folderId).toBe(drafts.id);
    expect(created.subject).toBe('Draft A');

    const updatedId = await provider.saveDraft(s, { id: draftId, subject: 'Draft A v2', body: 'second' });
    expect(updatedId).toBe(draftId);
    const updated = mbox.messages.find((m) => m.id === draftId)!;
    expect(updated.subject).toBe('Draft A v2');
    expect(updated.bodyText).toBe('second');
    expect(mbox.messages.filter((m) => m.id === draftId).length).toBe(1);
  });

  it('saveDraft with an unknown id rejects with NotFoundException', async () => {
    const { provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    await expect(
      provider.saveDraft(sessionFor('demo@memory.local'), { id: 'msg-does-not-exist', subject: 'x' }),
    ).rejects.toThrow(NotFoundException);
  });

  it("downloadAttachmentBuffer round-trips the seeded attachment's bytes and content type", async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const mbox = store.get('demo@memory.local')!;
    const withAttachment = mbox.messages.find((m) => m.hasAttachments)!;
    const part = withAttachment.attachments![0].part;

    const { data, contentType } = await provider.downloadAttachmentBuffer(
      sessionFor('demo@memory.local'), withAttachment.id, part,
    );
    expect(contentType).toBe('text/plain');
    expect(data.toString('utf-8')).toContain('Seeded attachment');
  });

  it('downloadAttachment yields a readable stream of the same bytes', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const mbox = store.get('demo@memory.local')!;
    const withAttachment = mbox.messages.find((m) => m.hasAttachments)!;
    const part = withAttachment.attachments![0].part;

    const { stream, contentType, filename } = await provider.downloadAttachment(
      sessionFor('demo@memory.local'), withAttachment.id, part,
    );
    expect(contentType).toBe('text/plain');
    expect(filename).toBe('notes.txt');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString('utf-8')).toContain('Seeded attachment');
  });

  it('downloadAttachmentBuffer on an unknown message rejects with NotFoundException', async () => {
    const { provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    await expect(
      provider.downloadAttachmentBuffer(sessionFor('demo@memory.local'), 'msg-does-not-exist', '2'),
    ).rejects.toThrow(NotFoundException);
  });

  it('uploadAttachment stores a buffer and returns a handle usable by sendMessage', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');
    const data = Buffer.from('hello attachment', 'utf-8');
    const aid = await provider.uploadAttachment(s, 'hello.txt', 'text/plain', data);
    expect(typeof aid).toBe('string');

    const { id } = await provider.sendMessage(s, { to: ['nobody@elsewhere.example'], subject: 'With file', body: 'x' }, [aid]);
    const mbox = store.get('demo@memory.local')!;
    const sentMsg = mbox.messages.find((m) => m.id === id)!;
    expect(sentMsg.hasAttachments).toBe(true);
    expect(sentMsg.attachments!.length).toBe(1);

    const part = sentMsg.attachments![0].part;
    const { data: roundTripped, contentType } = await provider.downloadAttachmentBuffer(s, id, part);
    expect(roundTripped.toString('utf-8')).toBe('hello attachment');
    expect(contentType).toBe('text/plain');
  });

  it('sendMessage delivery copies attachment bytes so the recipient can download them too', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    await provider.authenticate('memory.local', 'peer@memory.local', 'x'); // seed the recipient
    const sender = sessionFor('demo@memory.local');
    const data = Buffer.from('shared attachment bytes', 'utf-8');
    const aid = await provider.uploadAttachment(sender, 'shared.txt', 'text/plain', data);

    await provider.sendMessage(sender, { to: ['peer@memory.local'], subject: 'File for you', body: 'x' }, [aid]);

    const peer = store.get('peer@memory.local')!;
    const peerInbox = peer.folders.find((f) => f.type === 'inbox')!;
    const delivered = peer.messages.find((m) => m.subject === 'File for you' && m.folderId === peerInbox.id)!;
    expect(delivered.attachments!.length).toBe(1);

    const part = delivered.attachments![0].part;
    const { data: downloaded, contentType } = await provider.downloadAttachmentBuffer(
      sessionFor('peer@memory.local'), delivered.id, part,
    );
    expect(downloaded.toString('utf-8')).toBe('shared attachment bytes');
    expect(contentType).toBe('text/plain');
  });
});

describe('MemoryMailProvider — contacts, GAL, calendar, free/busy', () => {
  it('getContacts paginates the seeded contacts', async () => {
    const { provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');
    const page1 = await provider.getContacts(s, 5, 0);
    expect(page1.length).toBe(5);
    const page2 = await provider.getContacts(s, 5, 5);
    expect(page2.length).toBe(5);
    expect(page1.map((c) => c.id)).not.toEqual(page2.map((c) => c.id));
  });

  it('createContact returns a full ProviderContact with a new id, and it appears in getContacts', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');
    const before = (await provider.getContacts(s, 100, 0)).length;

    const created = await provider.createContact(s, {
      displayName: 'New Person',
      emails: [{ email: 'new.person@example.gov.rw', type: 'work', primary: true }],
      phones: [],
    });
    expect(created.id).toBeTruthy();
    expect(created.displayName).toBe('New Person');

    const after = await provider.getContacts(s, 100, 0);
    expect(after.length).toBe(before + 1);
    expect(after.some((c) => c.id === created.id)).toBe(true);
    expect(store.get('demo@memory.local')!.contacts.some((c) => c.id === created.id)).toBe(true);
  });

  it('modifyContact mutates an existing contact; unknown id rejects with NotFoundException', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');
    const mbox = store.get('demo@memory.local')!;
    const target = mbox.contacts[0];

    await provider.modifyContact(s, target.id, { jobTitle: 'Updated Title' });
    expect(mbox.contacts.find((c) => c.id === target.id)!.jobTitle).toBe('Updated Title');

    await expect(
      provider.modifyContact(s, 'contact-does-not-exist', { jobTitle: 'x' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('deleteContact removes a contact; unknown id rejects with NotFoundException', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');
    const mbox = store.get('demo@memory.local')!;
    const target = mbox.contacts[0];

    await provider.deleteContact(s, target.id);
    expect(mbox.contacts.some((c) => c.id === target.id)).toBe(false);

    await expect(provider.deleteContact(s, 'contact-does-not-exist')).rejects.toThrow(NotFoundException);
  });

  it('autoCompleteContacts substring-matches name/email and never throws (empty array on no match or bad session)', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');
    const mbox = store.get('demo@memory.local')!;
    const target = mbox.contacts[0];

    const byName = await provider.autoCompleteContacts(s, target.displayName!.slice(0, 4));
    expect(byName.some((r) => r.email === target.emails[0].email)).toBe(true);
    expect(byName[0]).toEqual(expect.objectContaining({ email: expect.any(String), display: expect.any(String) }));

    const byEmail = await provider.autoCompleteContacts(s, target.emails[0].email.slice(0, 6));
    expect(byEmail.some((r) => r.email === target.emails[0].email)).toBe(true);

    expect(await provider.autoCompleteContacts(s, 'zzz-no-such-thing')).toEqual([]);
    expect(await provider.autoCompleteContacts(sessionFor('nobody@memory.local'), 'a')).toEqual([]);
  });

  it('searchGal substring-matches name/email and never throws (empty array on no match or bad session)', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');
    const mbox = store.get('demo@memory.local')!;
    const target = mbox.contacts[1];

    const hits = await provider.searchGal(s, target.displayName!.slice(0, 4));
    expect(hits.some((r) => r.email === target.emails[0].email)).toBe(true);

    expect(await provider.searchGal(s, 'zzz-no-such-thing')).toEqual([]);
    expect(await provider.searchGal(sessionFor('nobody@memory.local'), 'a')).toEqual([]);
  });

  it('getCalendarEvents returns events whose startAt is within [startMs, endMs]', async () => {
    const { provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');
    const all = await provider.getCalendarEvents(s, NOW - 7 * 864e5, NOW + 7 * 864e5);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((e) => e.startAt.getTime() >= NOW - 7 * 864e5 && e.startAt.getTime() <= NOW + 7 * 864e5)).toBe(true);

    const narrow = await provider.getCalendarEvents(s, NOW + 100 * 864e5, NOW + 200 * 864e5);
    expect(narrow.length).toBe(0);
  });

  it('createCalendarEvent returns an id and the event appears in range', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');
    const startAt = new Date(NOW + 50 * 864e5);
    const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

    const id = await provider.createCalendarEvent(s, {
      title: 'Planning Session',
      startAt,
      endAt,
      allDay: false,
      organizerEmail: 'demo@memory.local',
      attendees: ['peer@memory.local'],
    });
    expect(typeof id).toBe('string');

    const inRange = await provider.getCalendarEvents(s, NOW + 49 * 864e5, NOW + 51 * 864e5);
    expect(inRange.some((e) => e.id === id && e.title === 'Planning Session')).toBe(true);
    const mbox = store.get('demo@memory.local')!;
    expect(mbox.events.find((e) => e.id === id)!.attendees).toEqual([{ email: 'peer@memory.local' }]);
  });

  it('modifyCalendarEvent mutates an existing event; unknown id rejects with NotFoundException', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');
    const mbox = store.get('demo@memory.local')!;
    const target = mbox.events[0];

    await provider.modifyCalendarEvent(s, target.id, {
      title: 'Renamed Meeting',
      startAt: target.startAt,
      endAt: target.endAt,
      allDay: false,
      organizerEmail: 'demo@memory.local',
    });
    expect(mbox.events.find((e) => e.id === target.id)!.title).toBe('Renamed Meeting');

    await expect(
      provider.modifyCalendarEvent(s, 'event-does-not-exist', {
        title: 'x', startAt: new Date(), endAt: new Date(), allDay: false, organizerEmail: 'demo@memory.local',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('deleteCalendarEvent removes an event; unknown id rejects with NotFoundException', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');
    const mbox = store.get('demo@memory.local')!;
    const target = mbox.events[0];

    await provider.deleteCalendarEvent(s, target.id);
    expect(mbox.events.some((e) => e.id === target.id)).toBe(false);

    await expect(provider.deleteCalendarEvent(s, 'event-does-not-exist')).rejects.toThrow(NotFoundException);
  });

  it('getAppointment returns a ProviderEventDetail for a known id, and null for an unknown id', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');
    const mbox = store.get('demo@memory.local')!;
    const target = mbox.events[0];

    const detail = await provider.getAppointment(s, target.id);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(target.id);
    expect(detail!.inviteMessageId).toBe(target.inviteId);

    const missing = await provider.getAppointment(s, 'event-does-not-exist');
    expect(missing).toBeNull();
  });

  it('sendInviteReply resolves as a no-op', async () => {
    const { provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');
    await expect(provider.sendInviteReply(s, 'inv-1', 'ACCEPT')).resolves.toBeUndefined();
  });

  it('getFreeBusy derives busy blocks from events in the window', async () => {
    const { provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = { host: 'memory.local', email: 'demo@memory.local', authToken: 't' };
    const fb = await provider.getFreeBusy(s, 'demo@memory.local', NOW - 7*864e5, NOW + 7*864e5);
    expect(fb.busy.length).toBeGreaterThan(0);
    expect(fb.busy.every((b) => b.e > b.s)).toBe(true);
  });

  it('getFreeBusy returns empty arrays for a target with no seeded mailbox', async () => {
    const { provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');
    const fb = await provider.getFreeBusy(s, 'unseeded@memory.local', NOW - 7 * 864e5, NOW + 7 * 864e5);
    expect(fb).toEqual({ busy: [], tentative: [], unavailable: [] });
  });
});

describe('MemoryMailProvider — settings surface (prefs, identities, signatures, password)', () => {
  it('implements MailProvider structurally', async () => {
    const { provider } = setup();
    const _p: MailProvider = provider;
    expect(_p.name).toBe('memory');
  });

  it('getPrefs returns the seeded prefs; modifyPrefs merges into them', async () => {
    const { provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');

    const prefs = await provider.getPrefs(s);
    expect(prefs.zimbraPrefComposeFormat).toBe('html');

    await provider.modifyPrefs(s, { zimbraPrefComposeFormat: 'text', zimbraPrefNewPref: 'v' });
    const after = await provider.getPrefs(s);
    expect(after.zimbraPrefComposeFormat).toBe('text');
    expect(after.zimbraPrefNewPref).toBe('v');
    // merge, not replace — untouched keys survive
    expect(after.zimbraPrefGroupMailBy).toBe('conversation');
  });

  it('getIdentities returns the seeded identities; modifyIdentity merges attrs; unknown id rejects with NotFoundException', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');

    const identities = await provider.getIdentities(s);
    expect(identities.length).toBeGreaterThan(0);
    const target = identities[0];

    await provider.modifyIdentity(s, target.id, { zimbraPrefFromDisplay: 'New Display' });
    const mbox = store.get('demo@memory.local')!;
    const updated = mbox.identities.find((i) => i.id === target.id)!;
    expect(updated.attrs.zimbraPrefFromDisplay).toBe('New Display');
    // merge — other attrs survive
    expect(updated.attrs.zimbraPrefFromAddress).toBe('demo@memory.local');

    await expect(
      provider.modifyIdentity(s, 'ident-does-not-exist', { zimbraPrefFromDisplay: 'x' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('getSignatures returns the seeded signatures; createSignature adds one that appears in getSignatures', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');

    const beforeCount = (await provider.getSignatures(s)).length;
    expect(beforeCount).toBeGreaterThan(0);

    const id = await provider.createSignature(s, 'Work', '<p>Work sig</p>');
    expect(typeof id).toBe('string');

    const after = await provider.getSignatures(s);
    expect(after.length).toBe(beforeCount + 1);
    expect(after.some((sig) => sig.id === id && sig.name === 'Work')).toBe(true);
    expect(store.get('demo@memory.local')!.signatures.some((sig) => sig.id === id)).toBe(true);
  });

  it('modifySignature mutates an existing signature; unknown id rejects with NotFoundException', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');
    const mbox = store.get('demo@memory.local')!;
    const target = mbox.signatures[0];

    await provider.modifySignature(s, target.id, 'Renamed', '<p>Renamed body</p>');
    const updated = mbox.signatures.find((sig) => sig.id === target.id)!;
    expect(updated.name).toBe('Renamed');
    expect(updated.contentHtml).toBe('<p>Renamed body</p>');

    await expect(
      provider.modifySignature(s, 'sig-does-not-exist', 'x', '<p>x</p>'),
    ).rejects.toThrow(NotFoundException);
  });

  it('deleteSignature removes a signature; unknown id rejects with NotFoundException', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');
    const mbox = store.get('demo@memory.local')!;
    const target = mbox.signatures[0];

    await provider.deleteSignature(s, target.id);
    expect(mbox.signatures.some((sig) => sig.id === target.id)).toBe(false);

    await expect(provider.deleteSignature(s, 'sig-does-not-exist')).rejects.toThrow(NotFoundException);
  });

  it('changePassword updates the stored mailbox password, and a subsequent authenticate with the new password still succeeds', async () => {
    const { store, provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'oldpw');
    const s = sessionFor('demo@memory.local');

    await provider.changePassword(s, 'oldpw', 'newpw');
    expect(store.get('demo@memory.local')!.password).toBe('newpw');

    const res = await provider.authenticate('memory.local', 'demo@memory.local', 'newpw');
    expect(res.authToken).toBeTruthy();
    expect(store.get('demo@memory.local')!.password).toBe('newpw');
  });

  it('none of the settings-surface methods throw CapabilityNotSupportedError', async () => {
    const { provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const s = sessionFor('demo@memory.local');
    await expect(provider.getPrefs(s)).resolves.toBeDefined();
    await expect(provider.modifyPrefs(s, {})).resolves.toBeUndefined();
    await expect(provider.getIdentities(s)).resolves.toBeDefined();
    await expect(provider.getSignatures(s)).resolves.toBeDefined();
    await expect(provider.changePassword(s, 'x', 'y')).resolves.toBeUndefined();
  });
});
