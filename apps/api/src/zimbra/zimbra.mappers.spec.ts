import { mapZimbraFolder, mapZimbraMessage } from './zimbra.mappers';

// These fixtures pin the wire→app parsing that MailService used to do inline
// (flag chars in `f`, address roles in `e[]`, the `mp[]` part walk). The REST
// responses are byte-identical only if this mapper reproduces that parsing
// exactly, so every expectation below was read off the old MailService code
// rather than off the Zimbra docs.
const rawMsg = {
  id: '257', cid: '-257', l: '2', su: 'Budget review', fr: 'Please find attached…',
  d: 1757404800000, s: 4096, f: 'ua',
  e: [
    // Display name is `d` on Zimbra's address element — NOT `p`.
    { t: 'f', a: 'alice@risa.gov.rw', d: 'Alice' },
    { t: 't', a: 'me@risa.gov.rw' },
    { t: 'c', a: 'cc@risa.gov.rw', d: 'Carol' },
    { t: 'b', a: 'bcc@risa.gov.rw' },
  ],
  mp: [{
    ct: 'multipart/mixed',
    mp: [
      { part: '1', ct: 'text/html', body: true, content: '<p>hi</p>' },
      { part: '1.1', ct: 'text/plain', body: true, content: 'hi' },
      { part: '2', ct: 'application/pdf', filename: 'ToR.pdf', s: 1000 },
    ],
  }],
  tn: 'NeedsDecision',
} as any;

describe('mapZimbraMessage', () => {
  it('maps a Zimbra search hit to ProviderMessage', () => {
    const m = mapZimbraMessage(rawMsg);
    expect(m).toMatchObject({
      id: '257', conversationId: '-257', folderId: '2',
      subject: 'Budget review', snippet: 'Please find attached…',
      from: { email: 'alice@risa.gov.rw', name: 'Alice' },
      size: 4096,
      isRead: false,       // 'u' flag present = unread
      isFlagged: false,
      isDraft: false,
      hasAttachments: true,
      tags: ['NeedsDecision'],
    });
    expect(m.receivedAt).toEqual(new Date(1757404800000));
  });

  it('splits addresses by role and preserves a missing display name as undefined', () => {
    const m = mapZimbraMessage(rawMsg);
    // `name: undefined` (not null) is what MailService stored in
    // toRecipients — JSON.stringify drops the key entirely, and callers that
    // need null apply their own `?? null`.
    expect(m.to).toEqual([{ email: 'me@risa.gov.rw', name: undefined }]);
    expect(m.cc).toEqual([{ email: 'cc@risa.gov.rw', name: 'Carol' }]);
    expect(m.bcc).toEqual([{ email: 'bcc@risa.gov.rw', name: undefined }]);
  });

  it('derives hasAttachments from the `a` flag, not from the part tree', () => {
    // A message carrying an attachment part but no `a` flag reports false —
    // this is what the list/search paths did (`flags.includes('a')`).
    const m = mapZimbraMessage({ ...rawMsg, f: '' });
    expect(m.hasAttachments).toBe(false);
  });

  it('reads unread / flagged / draft out of the flag string', () => {
    const m = mapZimbraMessage({ ...rawMsg, f: 'fd' });
    expect(m.isRead).toBe(true);
    expect(m.isFlagged).toBe(true);
    expect(m.isDraft).toBe(true);
  });

  it('extracts the html and plain-text bodies from nested parts', () => {
    const m = mapZimbraMessage(rawMsg);
    expect(m.bodyHtml).toBe('<p>hi</p>');
    expect(m.bodyText).toBe('hi');
  });

  it('collects real attachments and CID inline images in one walk, tagged by isInline', () => {
    const m = mapZimbraMessage({
      id: 'z1', l: '2', su: 'hi', d: 1, f: '', e: [],
      mp: [
        { part: '1', ct: 'text/html', body: true, content: '<p>hi <img src="cid:sig@x"></p>' },
        { part: '2', ct: 'image/gif', filename: 'inline.gif', ci: '<sig@x>', s: 1234 },
        { part: '3', ct: 'application/pdf', filename: 'report.pdf', s: 99 },
      ],
    } as any);

    expect(m.attachments).toEqual([
      // Inline images carry a content-id and are excluded from attachment counts.
      { part: '2', filename: 'inline.gif', contentType: 'image/gif', size: 1234, isInline: true, contentId: 'sig@x' },
      { part: '3', filename: 'report.pdf', contentType: 'application/pdf', size: 99, isInline: false, contentId: undefined },
    ]);
  });

  it('defaults a missing content type and size on an attachment part', () => {
    const m = mapZimbraMessage({
      id: 'z1', l: '2', d: 1, f: '', e: [],
      mp: [{ part: '2', filename: 'blob.bin' }],
    } as any);
    expect(m.attachments).toEqual([
      { part: '2', filename: 'blob.bin', contentType: 'application/octet-stream', size: 0, isInline: false, contentId: undefined },
    ]);
  });

  it('tolerates a bare search hit with no addresses, parts, tags or conversation', () => {
    const m = mapZimbraMessage({ id: 'z9', l: '2', d: 5, s: 0 } as any);
    expect(m).toMatchObject({
      id: 'z9', conversationId: null, folderId: '2',
      subject: null, snippet: null,
      from: { email: '', name: undefined },
      to: [], cc: [], bcc: [],
      isRead: true, isFlagged: false, isDraft: false, hasAttachments: false,
      tags: [], bodyHtml: null, bodyText: null, attachments: [],
    });
  });

  it('splits a multi-tag `tn` value', () => {
    expect(mapZimbraMessage({ ...rawMsg, tn: 'A,B' }).tags).toEqual(['A', 'B']);
  });
});

describe('mapZimbraFolder', () => {
  it('maps folders with unread/total counts and system paths', () => {
    const f = mapZimbraFolder({ id: '2', name: 'Inbox', absFolderPath: '/Inbox', u: 3, n: 40 } as any);
    expect(f).toMatchObject({ id: '2', name: 'Inbox', path: '/Inbox', unreadCount: 3, totalCount: 40 });
  });

  it('defaults missing counts to 0, stringifies numeric ids and carries the parent id', () => {
    const f = mapZimbraFolder({ id: 17, name: 'Reports', absFolderPath: '/Reports', l: 2 } as any);
    expect(f).toEqual({
      id: '17', name: 'Reports', path: '/Reports',
      unreadCount: 0, totalCount: 0, parentId: '2', view: undefined,
    });
  });

  it('synthesises a path from the name and names an unnamed folder', () => {
    expect(mapZimbraFolder({ id: '5', name: 'Odd' } as any).path).toBe('/Odd');
    const nameless = mapZimbraFolder({ id: '6' } as any);
    expect(nameless.name).toBe('Unnamed');
    expect(nameless.path).toBe('/');
  });

  it('carries the folder content class so callers can map it to their own folder type', () => {
    expect(mapZimbraFolder({ id: '7', name: 'Contacts', view: 'contact' } as any).view).toBe('contact');
  });
});
