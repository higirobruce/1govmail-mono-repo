import { readFileSync } from 'fs';
import { join } from 'path';
import { NotFoundException } from '@nestjs/common';
import { EwsService } from './ews.service';
import { MailSession } from '../provider/mail-session';

/**
 * Task 4 — EWS folders + message reads. Each op is exercised through a fake
 * transport that replays a recorded response fixture, asserting both the
 * request envelope that went out and the neutral DTO that came back.
 */

const KEY = 'test-mail-cred-key-0123456789abcdef';
const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');

const FIND_FOLDER = fixture('findfolder.success.xml');
const FIND_ITEM = fixture('finditem.success.xml');
const SEARCH_ITEM = fixture('searchitem.success.xml');
const GET_ITEM = fixture('getitem.success.xml');
const GET_ITEM_NOTFOUND = fixture('getitem.notfound.xml');
const CREATE_FOLDER = fixture('createfolder.success.xml');
const DELETE_FOLDER = fixture('deletefolder.success.xml');
const UPDATE_FOLDER = fixture('updatefolder.success.xml');
const EMPTY_FOLDER = fixture('emptyfolder.success.xml');

/** Replays `script` entries in order (last one repeats), recording every
 *  outbound body so envelope construction can be asserted. */
class FakeTransport {
  public calls: Array<{ session: MailSession; body: string }> = [];
  constructor(private script: string[]) {}
  async call(session: MailSession, body: string): Promise<string> {
    this.calls.push({ session, body });
    const idx = Math.min(this.calls.length - 1, this.script.length - 1);
    return this.script[idx];
  }
}

const SESSION: MailSession = {
  host: 'webmail.minaffet.gov.rw',
  email: 'test-risa1@minaffet.gov.rw',
  credentials: { username: 'MINAFFET\\test-risa1', password: 'fake-pw' },
};

const svcWith = (...script: string[]) => {
  const t = new FakeTransport(script);
  const svc = new EwsService(t as any);
  return { t, svc };
};

describe('EwsService folders + messages (Task 4)', () => {
  const ORIGINAL = process.env.MAIL_CRED_KEY;
  beforeEach(() => { process.env.MAIL_CRED_KEY = KEY; });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MAIL_CRED_KEY;
    else process.env.MAIL_CRED_KEY = ORIGINAL;
  });

  describe('getFolders', () => {
    it('sends a Deep FindFolder from msgfolderroot', async () => {
      const { t, svc } = svcWith(FIND_FOLDER);
      await svc.getFolders(SESSION);
      expect(t.calls[0].body).toContain('<m:FindFolder Traversal="Deep">');
      expect(t.calls[0].body).toContain('<t:DistinguishedFolderId Id="msgfolderroot"/>');
    });

    it('maps well-known display names to folder types with kind mail + counts', async () => {
      const { svc } = svcWith(FIND_FOLDER);
      const folders = await svc.getFolders(SESSION);

      expect(folders).toHaveLength(6);
      const byName = Object.fromEntries(folders.map((f) => [f.name, f]));

      expect(byName['Inbox']).toMatchObject({
        id: 'AAA-Inbox=', type: 'inbox', kind: 'mail', unreadCount: 3, totalCount: 42,
        path: 'Inbox', parentId: 'AAA-Root=',
      });
      expect(byName['Sent Items'].type).toBe('sent');
      expect(byName['Drafts'].type).toBe('drafts');
      expect(byName['Deleted Items'].type).toBe('trash');
      expect(byName['Junk Email'].type).toBe('junk');
      expect(byName['Projects'].type).toBe('custom');
      expect(byName['Projects'].parentId).toBe('AAA-Inbox=');
      // every required field present on every folder
      for (const f of folders) {
        expect(typeof f.id).toBe('string');
        expect(typeof f.unreadCount).toBe('number');
        expect(typeof f.totalCount).toBe('number');
        expect(f.kind).toBe('mail');
      }
    });
  });

  describe('getMessages', () => {
    it('sends a paged FindItem over the folder sorted newest-first', async () => {
      const { t, svc } = svcWith(FIND_ITEM);
      await svc.getMessages(SESSION, 'AAA-Inbox=', 25, 50);
      expect(t.calls[0].body).toContain('<m:FindItem Traversal="Shallow">');
      expect(t.calls[0].body).toContain(
        '<m:IndexedPageItemView MaxEntriesReturned="25" Offset="50" BasePoint="Beginning"/>',
      );
      expect(t.calls[0].body).toContain('<t:FolderId Id="AAA-Inbox="/>');
    });

    it('defaults offset to 0 and limit to 50 when omitted', async () => {
      const { t, svc } = svcWith(FIND_ITEM);
      await svc.getMessages(SESSION, 'AAA-Inbox=');
      expect(t.calls[0].body).toContain('MaxEntriesReturned="50"');
      expect(t.calls[0].body).toContain('Offset="0"');
    });

    it('maps items to ProviderMessage with every required field', async () => {
      const { svc } = svcWith(FIND_ITEM);
      const page = await svc.getMessages(SESSION, 'AAA-Inbox=');
      const m = page.messages[0];
      expect(m).toMatchObject({
        id: 'ITEM-1==',
        conversationId: 'CONV-A==',
        folderId: 'AAA-Inbox=',
        subject: 'Quarterly budget review',
        snippet: 'Please find attached the revised figures for Q3 ...',
        size: 18453,
        isRead: false,
        isFlagged: true,
        hasAttachments: true,
        isDraft: false,
      });
      expect(m.from).toEqual({ email: 'alice.umutoni@minaffet.gov.rw', name: 'Alice Umutoni' });
      expect(m.to).toEqual([{ email: 'test-risa1@minaffet.gov.rw', name: 'Test Risa' }]);
      expect(m.cc).toEqual([]);
      expect(m.bcc).toEqual([]);
      expect(m.tags).toEqual([]);
      expect(m.receivedAt).toBeInstanceOf(Date);
      expect(m.receivedAt.toISOString()).toBe('2026-09-09T14:32:10.000Z');
      // second message: read, not flagged, two recipients
      const m2 = page.messages[1];
      expect(m2.isRead).toBe(true);
      expect(m2.isFlagged).toBe(false);
      expect(m2.to).toHaveLength(2);
    });

    it('computes pagination: total from TotalItemsInView, more when window is short', async () => {
      const { svc } = svcWith(FIND_ITEM);
      const page = await svc.getMessages(SESSION, 'AAA-Inbox=', 25, 0);
      expect(page.total).toBe(57);
      expect(page.messages).toHaveLength(2);
      // offset 0 + 2 returned < 57 → more
      expect(page.more).toBe(true);
    });

    it('reports more=false when the window reaches the end', async () => {
      const { svc } = svcWith(FIND_ITEM);
      // offset 55 + 2 returned = 57 = total → no more
      const page = await svc.getMessages(SESSION, 'AAA-Inbox=', 25, 55);
      expect(page.more).toBe(false);
    });
  });

  describe('searchMessages', () => {
    it('sends a FindItem with an AQS QueryString', async () => {
      const { t, svc } = svcWith(SEARCH_ITEM);
      await svc.searchMessages(SESSION, 'invoice');
      expect(t.calls[0].body).toContain('<m:QueryString>invoice</m:QueryString>');
    });

    it('returns a page of ProviderMessage from the search hits', async () => {
      const { svc } = svcWith(SEARCH_ITEM);
      const page = await svc.searchMessages(SESSION, 'invoice');
      expect(page.total).toBe(1);
      expect(page.more).toBe(false);
      expect(page.messages[0]).toMatchObject({
        id: 'SEARCH-1==', subject: 'Invoice 2026-0042', hasAttachments: true,
      });
    });
  });

  describe('getMessage', () => {
    it('sends a GetItem for the id and returns the full message with body + attachments', async () => {
      const { t, svc } = svcWith(GET_ITEM);
      const msg = await svc.getMessage(SESSION, 'ITEM-1==');
      expect(t.calls[0].body).toContain('<t:ItemId Id="ITEM-1=="/>');
      expect(t.calls[0].body).toContain('<t:BodyType>HTML</t:BodyType>');

      expect(msg.id).toBe('ITEM-1==');
      expect(msg.conversationId).toBe('CONV-A==');
      expect(msg.folderId).toBe('AAA-Inbox=');
      expect(msg.bodyHtml).toContain('<p>Please find attached the revised figures.</p>');
      expect(msg.bodyText).toBeNull();
      expect(msg.cc).toEqual([{ email: 'dan.habimana@minaffet.gov.rw', name: 'Dan Habimana' }]);
      expect(msg.bcc).toEqual([]);
      expect(msg.attachments).toHaveLength(2);
      expect(msg.attachments![0]).toEqual({
        part: 'ATT-1==',
        filename: 'Q3-figures.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 40211,
        isInline: false,
      });
      expect(msg.attachments![1]).toEqual({
        part: 'ATT-2==',
        filename: 'logo.png',
        contentType: 'image/png',
        size: 2048,
        isInline: true,
        contentId: 'logo@minaffet',
      });
    });

    it('does not mark the message read on fetch (no UpdateItem call)', async () => {
      const { t, svc } = svcWith(GET_ITEM);
      await svc.getMessage(SESSION, 'ITEM-1==');
      expect(t.calls).toHaveLength(1);
      expect(t.calls[0].body).not.toContain('UpdateItem');
    });

    it('maps an ErrorItemNotFound response to NotFoundException', async () => {
      const { svc } = svcWith(GET_ITEM_NOTFOUND);
      await expect(svc.getMessage(SESSION, 'nope==')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('folder mutations', () => {
    it('createFolder returns the new folder as a custom mail folder', async () => {
      const { t, svc } = svcWith(CREATE_FOLDER);
      const folder = await svc.createFolder(SESSION, 'Reports', 'AAA-Inbox=');
      expect(t.calls[0].body).toContain('<m:CreateFolder>');
      expect(t.calls[0].body).toContain('<t:FolderId Id="AAA-Inbox="/>');
      expect(folder).toMatchObject({
        id: 'AAA-NewFolder=', name: 'Reports', path: 'Reports',
        type: 'custom', kind: 'mail', unreadCount: 0, totalCount: 0, parentId: 'AAA-Inbox=',
      });
    });

    it('deleteFolder issues a HardDelete and resolves void', async () => {
      const { t, svc } = svcWith(DELETE_FOLDER);
      await expect(svc.deleteFolder(SESSION, 'F==')).resolves.toBeUndefined();
      expect(t.calls[0].body).toContain('DeleteType="HardDelete"');
    });

    it('renameFolder sets folder:DisplayName and resolves void', async () => {
      const { t, svc } = svcWith(UPDATE_FOLDER);
      await expect(svc.renameFolder(SESSION, 'AAA-Projects=', 'Archive')).resolves.toBeUndefined();
      expect(t.calls[0].body).toContain('<t:DisplayName>Archive</t:DisplayName>');
    });

    it('emptyFolder moves contents to Deleted Items and resolves void', async () => {
      const { t, svc } = svcWith(EMPTY_FOLDER);
      await expect(svc.emptyFolder(SESSION, 'F==')).resolves.toBeUndefined();
      expect(t.calls[0].body).toContain('DeleteType="MoveToDeletedItems"');
    });
  });
});
