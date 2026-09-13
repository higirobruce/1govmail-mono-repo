import { readFileSync } from 'fs';
import { join } from 'path';
import { NotFoundException } from '@nestjs/common';
import { EWS_SEARCH_CONCURRENCY, EWS_SEARCH_MAX_FOLDERS, EwsService } from './ews.service';
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
const FIND_ITEM_MEETING = fixture('finditem-meeting.success.xml');
const GET_ITEM_MEETING = fixture('getitem-meeting.success.xml');
const CONV_TOPIC = fixture('finditem-conversationtopic.success.xml');
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

/**
 * Exchange rejects a FindItem that names more than one ParentFolderId
 * ("ErrorInvalidOperation: Shared folder search cannot be performed on multiple
 * folders" — captured live from MINAFFET), so a mailbox-wide search fans out
 * one request per folder. This transport answers the FindFolder enumeration and
 * then routes each per-folder FindItem by the FolderId in its body, so the
 * assertions do not depend on the (concurrent, therefore unordered) call order.
 */
class FanoutTransport {
  public calls: Array<{ session: MailSession; body: string }> = [];
  public inFlight = 0;
  public peakInFlight = 0;
  constructor(
    private folderXml: string,
    private byFolder: Record<string, string | (() => Promise<string>)>,
  ) {}
  async call(session: MailSession, body: string): Promise<string> {
    this.calls.push({ session, body });
    if (body.includes('<m:FindFolder')) return this.folderXml;
    const id = /<t:FolderId Id="([^"]*)"\/>/.exec(body)?.[1] ?? '';
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    try {
      const scripted = this.byFolder[id];
      if (scripted === undefined) throw new Error(`unscripted folder ${id}`);
      return typeof scripted === 'function' ? await scripted() : scripted;
    } finally {
      this.inFlight -= 1;
    }
  }
  /** The FolderId each per-folder FindItem was scoped to, in call order. */
  searchedFolderIds(): string[] {
    return this.calls
      .filter((c) => !c.body.includes('<m:FindFolder'))
      .map((c) => /<t:FolderId Id="([^"]*)"\/>/.exec(c.body)?.[1] ?? '');
  }
}

/** A one-hit FindItemResponse for a single folder. */
const hitXml = (id: string, receivedIso: string) =>
  `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
  <m:FindItemResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
    xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
    <m:ResponseMessages><m:FindItemResponseMessage ResponseClass="Success">
      <m:ResponseCode>NoError</m:ResponseCode>
      <m:RootFolder TotalItemsInView="1" IncludesLastItemInRange="true"><t:Items>
        <t:Message>
          <t:ItemId Id="${id}" ChangeKey="K"/>
          <t:Subject>hit ${id}</t:Subject>
          <t:DateTimeReceived>${receivedIso}</t:DateTimeReceived>
          <t:Size>10</t:Size>
          <t:HasAttachments>false</t:HasAttachments>
          <t:From><t:Mailbox><t:EmailAddress>a@minaffet.gov.rw</t:EmailAddress></t:Mailbox></t:From>
          <t:IsRead>true</t:IsRead>
        </t:Message>
      </t:Items></m:RootFolder>
    </m:FindItemResponseMessage></m:ResponseMessages>
  </m:FindItemResponse>
</s:Body></s:Envelope>`;

/** An empty (but successful) FindItemResponse. */
const EMPTY_HITS = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
  <m:FindItemResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
    xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
    <m:ResponseMessages><m:FindItemResponseMessage ResponseClass="Success">
      <m:ResponseCode>NoError</m:ResponseCode>
      <m:RootFolder TotalItemsInView="0" IncludesLastItemInRange="true"><t:Items/></m:RootFolder>
    </m:FindItemResponseMessage></m:ResponseMessages>
  </m:FindItemResponse>
</s:Body></s:Envelope>`;

/** The exact shape Exchange returned for the rejected multi-folder search. */
const SHARED_FOLDER_ERROR = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
  <m:FindItemResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
    xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
    <m:ResponseMessages><m:FindItemResponseMessage ResponseClass="Error">
      <m:MessageText>Shared folder search cannot be performed on multiple folders.</m:MessageText>
      <m:ResponseCode>ErrorInvalidOperation</m:ResponseCode>
    </m:FindItemResponseMessage></m:ResponseMessages>
  </m:FindItemResponse>
</s:Body></s:Envelope>`;

/** A FindFolderResponse carrying no folders at all. */
const EMPTY_FOLDERS = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
  <m:FindFolderResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
    xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
    <m:ResponseMessages><m:FindFolderResponseMessage ResponseClass="Success">
      <m:ResponseCode>NoError</m:ResponseCode>
      <m:RootFolder TotalItemsInView="0"><t:Folders/></m:RootFolder>
    </m:FindFolderResponseMessage></m:ResponseMessages>
  </m:FindFolderResponse>
</s:Body></s:Envelope>`;

/** A FindFolderResponse with `count` plain mail folders (F0, F1, ...). */
const manyFolders = (count: number) => `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
  <m:FindFolderResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
    xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
    <m:ResponseMessages><m:FindFolderResponseMessage ResponseClass="Success">
      <m:ResponseCode>NoError</m:ResponseCode>
      <m:RootFolder TotalItemsInView="${count}"><t:Folders>
        ${Array.from({ length: count }, (_, i) =>
          `<t:Folder><t:FolderId Id="F${i}=" ChangeKey="K"/><t:DisplayName>Folder ${i}</t:DisplayName>` +
          `<t:TotalCount>1</t:TotalCount><t:UnreadCount>0</t:UnreadCount></t:Folder>`).join('')}
      </t:Folders></m:RootFolder>
    </m:FindFolderResponseMessage></m:ResponseMessages>
  </m:FindFolderResponse>
</s:Body></s:Envelope>`;

/** The six mail folders in the FindFolder fixture. */
const ALL_FOLDERS = ['AAA-Inbox=', 'AAA-Sent=', 'AAA-Drafts=', 'AAA-Deleted=', 'AAA-Junk=', 'AAA-Projects='];

const fanoutWith = (byFolder: Record<string, string | (() => Promise<string>)>) => {
  const t = new FanoutTransport(FIND_FOLDER, byFolder);
  return { t, svc: new EwsService(t as any) };
};

const allFoldersAnswering = (xml: string) =>
  Object.fromEntries(ALL_FOLDERS.map((id) => [id, xml])) as Record<string, string>;

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
        path: '/Inbox', parentId: 'AAA-Root=',
      });
      // system folders carry the canonical Zimbra-style path the web sidebar
      // matches on — NOT the raw Exchange DisplayName
      expect(byName['Sent Items']).toMatchObject({ type: 'sent', path: '/Sent' });
      expect(byName['Drafts']).toMatchObject({ type: 'drafts', path: '/Drafts' });
      expect(byName['Deleted Items']).toMatchObject({ type: 'trash', path: '/Trash' });
      expect(byName['Junk Email']).toMatchObject({ type: 'junk', path: '/Junk' });
      // a user/custom folder keeps a DisplayName-based path (never a builtin
      // path) so it correctly lands under Labels
      expect(byName['Projects']).toMatchObject({ type: 'custom', path: 'Projects' });
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

    it('requests the ConversationTopic extended property (Exchange FindItem never returns ConversationId)', async () => {
      const { t, svc } = svcWith(FIND_ITEM);
      await svc.getMessages(SESSION, 'AAA-Inbox=');
      expect(t.calls[0].body).toContain(
        '<t:ExtendedFieldURI PropertyTag="0x0070" PropertyType="String"/>',
      );
    });

    it('groups by ConversationTopic and falls back to ItemId so conversationId is never null', async () => {
      const { svc } = svcWith(CONV_TOPIC);
      const page = await svc.getMessages(SESSION, 'AAA-Inbox=');
      // Two messages sharing the (prefix-stripped) topic collapse to one thread key…
      expect(page.messages[0].conversationId).toBe('Budget planning');
      expect(page.messages[1].conversationId).toBe('Budget planning');
      // …and a message with no topic (and no ConversationId) falls back to its own id.
      expect(page.messages[2].conversationId).toBe('ITEM-C==');
      // Never null — a null id would drop the message onto the single-message layout.
      expect(page.messages.every((m) => m.conversationId)).toBe(true);
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

    it('includes meeting-request items alongside plain messages in the listing', async () => {
      // Real inboxes return invites as <t:MeetingRequest> (and Cancellation /
      // Response) rather than <t:Message>; these must not vanish from listings.
      const { svc } = svcWith(FIND_ITEM_MEETING);
      const page = await svc.getMessages(SESSION, 'AAA-Inbox=');
      expect(page.messages).toHaveLength(2);
      const byId = Object.fromEntries(page.messages.map((m) => [m.id, m]));
      expect(byId['MSG-1==']).toBeDefined();
      const invite = byId['MTG-1=='];
      expect(invite).toBeDefined();
      expect(invite.subject).toBe('Invitation: Cabinet briefing');
      expect(invite.from).toEqual({ email: 'bob.mugisha@minaffet.gov.rw', name: 'Bob Mugisha' });
      expect(invite.isRead).toBe(false);
    });
  });

  describe('searchMessages', () => {
    it('enumerates the mail folders, then sends ONE FindItem per folder', async () => {
      // FindItem can neither recurse (no Deep traversal — msgfolderroot holds no
      // mail) nor take more than one ParentFolderId on a shared mailbox
      // (ErrorInvalidOperation "Shared folder search cannot be performed on
      // multiple folders", captured live from MINAFFET). So mailbox-wide search
      // is a fan-out: one single-folder FindItem each, merged here.
      const { t, svc } = fanoutWith(allFoldersAnswering(EMPTY_HITS));
      await svc.searchMessages(SESSION, 'invoice');

      expect(t.calls[0].body).toContain('<m:FindFolder Traversal="Deep">');
      expect(t.searchedFolderIds().sort()).toEqual([...ALL_FOLDERS].sort());
      for (const call of t.calls.slice(1)) {
        expect(call.body).toContain('<m:QueryString>invoice</m:QueryString>');
        expect(call.body.match(/<t:FolderId /g)).toHaveLength(1); // never multi-folder
        expect(call.body).not.toContain('msgfolderroot');
      }
    });

    it('merges the per-folder hits newest-first and sums their totals', async () => {
      const { svc } = fanoutWith({
        'AAA-Inbox=': hitXml('INBOX-1==', '2026-09-01T08:00:00Z'),
        'AAA-Sent=': hitXml('SENT-1==', '2026-09-09T08:00:00Z'),
        'AAA-Drafts=': EMPTY_HITS,
        'AAA-Deleted=': EMPTY_HITS,
        'AAA-Junk=': EMPTY_HITS,
        'AAA-Projects=': hitXml('PROJ-1==', '2026-09-05T08:00:00Z'),
      });
      const page = await svc.searchMessages(SESSION, 'invoice');

      expect(page.messages.map((m) => m.id)).toEqual(['SENT-1==', 'PROJ-1==', 'INBOX-1==']);
      expect(page.total).toBe(3);
      expect(page.more).toBe(false);
      // each hit carries the folder its own request was scoped to
      expect(page.messages.map((m) => m.folderId)).toEqual(['AAA-Sent=', 'AAA-Projects=', 'AAA-Inbox=']);
    });

    it('applies limit/offset to the MERGED result, not per folder', async () => {
      const { svc } = fanoutWith({
        'AAA-Inbox=': hitXml('INBOX-1==', '2026-09-01T08:00:00Z'),
        'AAA-Sent=': hitXml('SENT-1==', '2026-09-09T08:00:00Z'),
        'AAA-Drafts=': EMPTY_HITS,
        'AAA-Deleted=': EMPTY_HITS,
        'AAA-Junk=': EMPTY_HITS,
        'AAA-Projects=': hitXml('PROJ-1==', '2026-09-05T08:00:00Z'),
      });
      const page = await svc.searchMessages(SESSION, 'invoice', 1, 1);
      expect(page.messages.map((m) => m.id)).toEqual(['PROJ-1==']); // 2nd newest overall
      expect(page.total).toBe(3);
      expect(page.more).toBe(true);
    });

    it('skips a folder whose own search fails and still returns the rest', async () => {
      // A mailbox can hold a folder Exchange refuses to search; one bad folder
      // must not take the whole search down with it.
      const { svc } = fanoutWith({
        ...allFoldersAnswering(EMPTY_HITS),
        'AAA-Inbox=': hitXml('INBOX-1==', '2026-09-01T08:00:00Z'),
        'AAA-Junk=': SHARED_FOLDER_ERROR,
      });
      const page = await svc.searchMessages(SESSION, 'invoice');
      expect(page.messages.map((m) => m.id)).toEqual(['INBOX-1==']);
      expect(page.total).toBe(1);
    });

    it('throws when EVERY folder search fails, instead of reporting an empty mailbox', async () => {
      const { svc } = fanoutWith(allFoldersAnswering(SHARED_FOLDER_ERROR));
      await expect(svc.searchMessages(SESSION, 'invoice')).rejects.toThrow(/ErrorInvalidOperation/);
    });

    it('bounds how many folder searches run at once', async () => {
      const slow = () => new Promise<string>((r) => setTimeout(() => r(EMPTY_HITS), 5));
      const { t, svc } = fanoutWith(
        Object.fromEntries(ALL_FOLDERS.map((id) => [id, slow])) as Record<string, () => Promise<string>>,
      );
      await svc.searchMessages(SESSION, 'invoice');
      expect(t.peakInFlight).toBeGreaterThan(1); // genuinely parallel
      expect(t.peakInFlight).toBeLessThanOrEqual(EWS_SEARCH_CONCURRENCY);
    });

    it('caps the fan-out and says so, rather than firing one request per folder forever', async () => {
      const over = EWS_SEARCH_MAX_FOLDERS + 5;
      const t = new FanoutTransport(
        manyFolders(over),
        Object.fromEntries(Array.from({ length: over }, (_, i) => [`F${i}=`, EMPTY_HITS])),
      );
      const svc = new EwsService(t as any);
      const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

      await svc.searchMessages(SESSION, 'invoice');

      expect(t.searchedFolderIds()).toHaveLength(EWS_SEARCH_MAX_FOLDERS);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(String(over - EWS_SEARCH_MAX_FOLDERS)));
      warn.mockRestore();
    });

    it('returns an empty page when the mailbox reports no mail folders', async () => {
      const { t, svc } = svcWith(EMPTY_FOLDERS);
      const page = await svc.searchMessages(SESSION, 'invoice');
      expect(page).toEqual({ messages: [], total: 0, more: false });
      expect(t.calls).toHaveLength(1); // nothing to search — no FindItem at all
    });
  });

  describe('searchStructured', () => {
    it('sends a FindItem with a translated AQS QueryString and folder scope', async () => {
      const { t, svc } = svcWith(SEARCH_ITEM);
      await svc.searchStructured(SESSION, { from: 'alice', subject: 'invoice', folderId: 'AAA-Inbox=' });
      const body = t.calls[0].body;
      expect(body).toContain('<m:QueryString>from:&quot;alice&quot; subject:&quot;invoice&quot;</m:QueryString>');
      expect(body).toContain('<t:FolderId Id="AAA-Inbox="/>');
      expect(body).not.toContain('AAA-Inbox=</m:QueryString>'); // folder never leaks into the query
    });

    it('fans out over every mail folder when no folderId is given', async () => {
      const { t, svc } = fanoutWith(allFoldersAnswering(EMPTY_HITS));
      await svc.searchStructured(SESSION, { keyword: 'invoice' });
      expect(t.searchedFolderIds().sort()).toEqual([...ALL_FOLDERS].sort());
      // FindFolder is legitimately rooted at msgfolderroot; no SEARCH may be.
      const searches = t.calls.filter((c) => !c.body.includes('<m:FindFolder'));
      expect(searches.some((c) => c.body.includes('msgfolderroot'))).toBe(false);
    });

    it('returns a page of ProviderMessage from the search hits', async () => {
      const { svc } = svcWith(SEARCH_ITEM);
      const page = await svc.searchStructured(SESSION, { keyword: 'invoice', folderId: 'AAA-Inbox=' });
      expect(page.total).toBe(1);
      expect(page.messages[0]).toMatchObject({ id: 'SEARCH-1==', subject: 'Invoice 2026-0042' });
    });
  });

  describe('searchStructured (advanced search)', () => {
    it('searches the WHOLE mailbox as one single-folder FindItem per folder', async () => {
      // Two live Exchange constraints stack here: FindItem cannot recurse (so
      // msgfolderroot searches an empty container and returns zero) AND it
      // refuses more than one ParentFolderId on this mailbox
      // ("Shared folder search cannot be performed on multiple folders").
      const { t, svc } = fanoutWith(allFoldersAnswering(EMPTY_HITS));
      await svc.searchStructured(SESSION, { from: 'alice@minaffet.gov.rw' });

      expect(t.calls[0].body).toContain('<m:FindFolder Traversal="Deep">');
      expect(t.searchedFolderIds().sort()).toEqual([...ALL_FOLDERS].sort());
      for (const call of t.calls.slice(1)) {
        expect(call.body).toContain('from:&quot;alice@minaffet.gov.rw&quot;');
        expect(call.body.match(/<t:FolderId /g)).toHaveLength(1);
        expect(call.body).not.toContain('msgfolderroot');
      }
    });

    it('merges the per-folder responses newest-first and sums their totals', async () => {
      const { svc } = fanoutWith({
        ...allFoldersAnswering(EMPTY_HITS),
        'AAA-Inbox=': hitXml('INBOX-1==', '2026-09-01T08:00:00Z'),
        'AAA-Sent=': hitXml('SENT-1==', '2026-09-09T08:00:00Z'),
      });
      const page = await svc.searchStructured(SESSION, { from: 'x@y.rw' });

      expect(page.messages.map((m) => m.id)).toEqual(['SENT-1==', 'INBOX-1==']);
      expect(page.total).toBe(2);
      // each item recovers the folder its own request was scoped to
      expect(page.messages[0].folderId).toBe('AAA-Sent=');
      expect(page.messages[1].folderId).toBe('AAA-Inbox=');
    });

    it('keeps a single-folder search to one FindItem, with no folder enumeration', async () => {
      const { t, svc } = svcWith(SEARCH_ITEM);
      await svc.searchStructured(SESSION, { from: 'a@b.rw', folderId: 'AAA-Inbox=' });

      expect(t.calls).toHaveLength(1);
      expect(t.calls[0].body).toContain('<t:FolderId Id="AAA-Inbox="/>');
      expect(t.calls[0].body).not.toContain('FindFolder');
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

    it('opens a MeetingRequest item (invite) the same as a plain message', async () => {
      const { svc } = svcWith(GET_ITEM_MEETING);
      const msg = await svc.getMessage(SESSION, 'MTG-1==');
      expect(msg.id).toBe('MTG-1==');
      expect(msg.subject).toBe('Invitation: Cabinet briefing');
      expect(msg.folderId).toBe('AAA-Inbox=');
      expect(msg.bodyHtml).toContain('<p>You are invited to the Cabinet briefing.</p>');
      expect(msg.from).toEqual({ email: 'bob.mugisha@minaffet.gov.rw', name: 'Bob Mugisha' });
      expect(msg.to).toEqual([{ email: 'test-risa1@minaffet.gov.rw', name: 'Test Risa' }]);
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
