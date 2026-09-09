import { MemoryMailProvider } from './memory-mail.provider';
import { MemoryStore } from './memory-store';
import { UnauthorizedException, NotFoundException } from '@nestjs/common';

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
});
