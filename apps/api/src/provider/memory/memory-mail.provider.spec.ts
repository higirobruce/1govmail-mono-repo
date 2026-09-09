import { MemoryMailProvider } from './memory-mail.provider';
import { MemoryStore } from './memory-store';
import { UnauthorizedException } from '@nestjs/common';

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
