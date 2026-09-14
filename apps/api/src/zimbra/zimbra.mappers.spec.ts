import {
  mapProviderContactToZimbraAttrs,
  mapCalendarEventPayloadToZimbraMessage,
  mapZimbraAppointment,
  mapZimbraAppointmentDetail,
  mapZimbraContact,
  mapZimbraFolder,
  mapZimbraFreeBusy,
  mapZimbraMessage,
} from './zimbra.mappers';

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
      unreadCount: 0, totalCount: 0, parentId: '2', kind: undefined,
    });
  });

  it('synthesises a path from the name and names an unnamed folder', () => {
    expect(mapZimbraFolder({ id: '5', name: 'Odd' } as any).path).toBe('/Odd');
    const nameless = mapZimbraFolder({ id: '6' } as any);
    expect(nameless.name).toBe('Unnamed');
    expect(nameless.path).toBe('/');
  });

  it('translates the Zimbra content class into the neutral folder kind', () => {
    const kindOf = (view?: string) =>
      mapZimbraFolder({ id: '7', name: 'F', view } as any).kind;

    expect(kindOf('message')).toBe('mail');
    expect(kindOf('contact')).toBe('contacts');
    expect(kindOf('appointment')).toBe('calendar');
    expect(kindOf('task')).toBe('tasks');
    expect(kindOf('document')).toBe('documents');
  });

  it('leaves the kind unset for an absent or unrecognised content class', () => {
    // MailService reads an unset kind as mail, which is what its old
    // `default:` arm did for these — so the derived folder type is unchanged.
    expect(mapZimbraFolder({ id: '7', name: 'F' } as any).kind).toBeUndefined();
    expect(mapZimbraFolder({ id: '7', name: 'F', view: 'wiki' } as any).kind).toBeUndefined();
  });
});

// mapZimbraContact must replicate ContactsService.parseZimbraContact's `_attrs`
// parsing exactly: rich {email,type,primary}/{number,type} arrays (not flat
// strings — the DB `emails`/`phones` JSON columns, and the REST payload
// apps/web reads with `c.emails.find(e => e.primary)`, are these shapes),
// and firstName/lastName/nickname/company/jobTitle/notes carried through.
describe('mapZimbraContact', () => {
  it('maps a Zimbra contact to ProviderContact', () => {
    const c = mapZimbraContact({ id: '310', _attrs: {
      firstName: 'Alice', lastName: 'Umutoni', fullName: 'Alice Umutoni',
      email: 'alice@risa.gov.rw', email2: 'a.umutoni@gmail.com',
      mobilePhone: '+250788111222', company: 'RISA',
    }} as any);
    expect(c).toMatchObject({
      id: '310', displayName: 'Alice Umutoni', firstName: 'Alice', lastName: 'Umutoni',
      emails: [
        { email: 'alice@risa.gov.rw', type: 'work', primary: true },
        { email: 'a.umutoni@gmail.com', type: 'personal' },
      ],
      phones: [{ number: '+250788111222', type: 'mobile' }],
      company: 'RISA',
    });
  });

  it('falls back to firstName + lastName for displayName when fullName is absent', () => {
    const c = mapZimbraContact({ id: '1', _attrs: { firstName: 'Bob', lastName: 'K' } } as any);
    expect(c.displayName).toBe('Bob K');
  });

  it('defaults nickname/company/jobTitle/notes to null and emails/phones to empty arrays when absent', () => {
    const c = mapZimbraContact({ id: '2', _attrs: {} } as any);
    expect(c).toMatchObject({
      id: '2', displayName: null, nickname: null, company: null, jobTitle: null, notes: null,
      emails: [], phones: [],
    });
  });

  it('maps email3/other and workPhone/homePhone type tags', () => {
    const c = mapZimbraContact({ id: '3', _attrs: {
      email3: 'other@risa.gov.rw', workPhone: '111', homePhone: '222',
    }} as any);
    expect(c.emails).toEqual([{ email: 'other@risa.gov.rw', type: 'other' }]);
    expect(c.phones).toEqual([{ number: '111', type: 'work' }, { number: '222', type: 'home' }]);
  });

  it('parses the a[] attribute-array format (GetContactsResponse shape)', () => {
    const c = mapZimbraContact({
      id: '4',
      a: [{ n: 'firstName', _content: 'Carol' }, { n: 'email', _content: 'carol@risa.gov.rw' }],
    } as any);
    expect(c).toMatchObject({
      id: '4', firstName: 'Carol', emails: [{ email: 'carol@risa.gov.rw', type: 'work', primary: true }],
    });
  });
});

describe('mapProviderContactToZimbraAttrs', () => {
  it('serialises a ProviderContact back into the Zimbra `a[]` attrs format', () => {
    const attrs = mapProviderContactToZimbraAttrs({
      firstName: 'Alice', lastName: 'Umutoni', displayName: 'Alice Umutoni',
      company: 'RISA', jobTitle: 'Director', nickname: 'Ali', notes: 'VIP',
      emails: [
        { email: 'alice@risa.gov.rw', type: 'work', primary: true },
        { email: 'a.umutoni@gmail.com', type: 'personal' },
      ],
      phones: [{ number: '+250788111222', type: 'mobile' }],
    });
    expect(attrs).toEqual(expect.arrayContaining([
      { n: 'firstName', _content: 'Alice' },
      { n: 'lastName', _content: 'Umutoni' },
      { n: 'fullName', _content: 'Alice Umutoni' },
      { n: 'company', _content: 'RISA' },
      { n: 'jobTitle', _content: 'Director' },
      { n: 'nickname', _content: 'Ali' },
      { n: 'notes', _content: 'VIP' },
      { n: 'email', _content: 'alice@risa.gov.rw' },
      { n: 'email2', _content: 'a.umutoni@gmail.com' },
      { n: 'mobilePhone', _content: '+250788111222' },
    ]));
    expect(attrs.length).toBe(10);
  });

  it('omits attrs for fields that are absent, null, or empty string', () => {
    const attrs = mapProviderContactToZimbraAttrs({ firstName: 'X', emails: [], phones: [] });
    expect(attrs).toEqual([{ n: 'firstName', _content: 'X' }]);
  });
});

// ─── Calendar ────────────────────────────────────────────────────────────────
//
// Two different wire shapes, two mappers. `SearchRequest types=appointment`
// (with calExpandInstStart/End) returns `appt` nodes carrying *expanded
// instances* in `inst[]`; `GetAppointmentRequest` returns a much richer `appt`
// node whose attendees hide under `inv[0].comp[0].at` and which carries the
// `ms`/`rev` conflict-detection counters plus the invite message id.
//
// Every expectation below was read off CalendarService.parseAppt (search hits)
// and CalendarService.getEvent/updateEvent (detail) — the task brief's starting
// fixture was corrected in three places, see the comments inline.

describe('mapZimbraAppointment', () => {
  // Correction #1 vs the brief fixture: the description comes off `desc`, not
  // `fr` — parseAppt reads `appt.desc ?? null` and never looks at the fragment.
  const rawAppt = {
    id: '401', name: 'Working session with COK',
    loc: 'KG1 Roundabout', allDay: false,
    inst: [{ s: 1757500200000 }],
    dur: 3600000,
    or: { a: 'bruce.higiro@risa.gov.rw', d: 'Bruce' },
    at: [{ a: 'alice@risa.gov.rw', d: 'Alice', ptst: 'AC' }],
    desc: 'Agenda: processes automation',
  } as any;

  it('maps a Zimbra appointment search hit to ProviderEvent', () => {
    const ev = mapZimbraAppointment(rawAppt)!;
    expect(ev).toMatchObject({
      id: '401', title: 'Working session with COK', location: 'KG1 Roundabout',
      allDay: false,
      description: 'Agenda: processes automation',
      isRecurring: false,
      inviteId: null,
      organizer: { email: 'bruce.higiro@risa.gov.rw', name: 'Bruce' },
    });
    expect(ev.startAt).toEqual(new Date(1757500200000));
    expect(ev.endAt).toEqual(new Date(1757500200000 + 3600000));
  });

  // Correction #2 vs the brief fixture: search-hit attendees are {email,name}
  // only. parseAppt never read `ptst` here, and this array is persisted verbatim
  // into the CalendarEvent.attendees JSON column that the REST list response
  // returns — adding a key would change the payload. Per-attendee ptst arrives
  // through the detail mapper below, which is where getEvent reads it.
  it('maps attendees to {email,name} without ptst (parseAppt fidelity)', () => {
    const ev = mapZimbraAppointment(rawAppt)!;
    expect(ev.attendees).toEqual([{ email: 'alice@risa.gov.rw', name: 'Alice' }]);
    expect(ev.attendees[0]).not.toHaveProperty('ptst');
  });

  it('returns null when the search hit has no expanded instance', () => {
    expect(mapZimbraAppointment({ id: '1', name: 'x' } as any)).toBeNull();
    expect(mapZimbraAppointment({ id: '1', inst: {} } as any)).toBeNull();
  });

  it('prefers the per-instance duration and allDay over the appointment-level ones', () => {
    const ev = mapZimbraAppointment({
      id: '9', inst: [{ s: 1000, dur: 500, allDay: true }], dur: 999, allDay: false,
    } as any)!;
    expect(ev.endAt).toEqual(new Date(1500));
    expect(ev.allDay).toBe(true);
  });

  it('defaults a missing duration to one hour and a missing start to the epoch', () => {
    const ev = mapZimbraAppointment({ id: '9', inst: [{}] } as any)!;
    expect(ev.startAt).toEqual(new Date(0));
    expect(ev.endAt).toEqual(new Date(3_600_000));
  });

  it('falls back title → su → (No title) and nulls a missing loc/desc/organizer', () => {
    expect(mapZimbraAppointment({ id: '9', su: 'From subject', inst: [{ s: 0 }] } as any)!.title)
      .toBe('From subject');
    const bare = mapZimbraAppointment({ id: '9', inst: [{ s: 0 }] } as any)!;
    expect(bare.title).toBe('(No title)');
    expect(bare.location).toBeNull();
    expect(bare.description).toBeNull();
    expect(bare.organizer).toBeUndefined();
    expect(bare.attendees).toEqual([]);
  });

  it('carries invId (the invite message id SendInviteReply needs) and the recurrence flag', () => {
    const ev = mapZimbraAppointment({
      id: '401', invId: 512, recur: { add: {} }, inst: [{ s: 0 }],
    } as any)!;
    expect(ev.inviteId).toBe('512');
    expect(ev.isRecurring).toBe(true);
  });
});

describe('mapZimbraAppointmentDetail', () => {
  it('reads attendees with ptst and the organizer out of inv[0].comp[0]', () => {
    const d = mapZimbraAppointmentDetail({
      id: '401', ms: 3, rev: 17,
      inv: [{ id: '512', comp: [{
        or: { a: 'bruce.higiro@risa.gov.rw', d: 'Bruce' },
        at: [
          { a: 'alice@risa.gov.rw', d: 'Alice', ptst: 'AC' },
          { a: 'bob@risa.gov.rw' },
        ],
      }] }],
    } as any);
    expect(d.attendees).toEqual([
      { email: 'alice@risa.gov.rw', name: 'Alice', ptst: 'AC' },
      { email: 'bob@risa.gov.rw', name: undefined, ptst: undefined },
    ]);
    expect(d.organizer).toEqual({ email: 'bruce.higiro@risa.gov.rw', name: 'Bruce' });
  });

  it('exposes the invite message id and the ms/rev conflict counters as numbers', () => {
    const d = mapZimbraAppointmentDetail({ id: '401', ms: '3', rev: '17', inv: [{ id: 512 }] } as any);
    // ModifyAppointmentRequest.id must be "{calItemId}-{invMsgId}" — the caller
    // joins them, so the mapper surfaces the invite half on its own.
    expect(d.inviteMessageId).toBe('512');
    expect(d.modifiedSequence).toBe(3);
    expect(d.rev).toBe(17);
  });

  it('resolves the invite message id through a bridge-collapsed object inv', () => {
    // Zimbra's JSON bridge returns single-item arrays as plain objects at any
    // level; updateEvent's firstOf() handled that for inv.id.
    const d = mapZimbraAppointmentDetail({ id: '401', inv: { id: '512' } } as any);
    expect(d.inviteMessageId).toBe('512');
  });

  it('falls back to the top-level at[]/or when the invite carries no attendee list', () => {
    const d = mapZimbraAppointmentDetail({
      id: '401', at: [{ a: 'carol@risa.gov.rw', ptst: 'NE' }], or: { a: 'org@risa.gov.rw' },
    } as any);
    expect(d.attendees).toEqual([{ email: 'carol@risa.gov.rw', name: undefined, ptst: 'NE' }]);
    expect(d.organizer).toEqual({ email: 'org@risa.gov.rw', name: undefined });
  });

  it('reports attendees as null when neither leg carries a list, so the caller can keep its cache', () => {
    const d = mapZimbraAppointmentDetail({ id: '401', inv: [{ id: '512', comp: [{}] }] } as any);
    expect(d.attendees).toBeNull();
    expect(d.organizer).toBeUndefined();
    expect(d.modifiedSequence).toBeUndefined();
    expect(d.rev).toBeUndefined();
  });

  it('does NOT read comp out of a bridge-collapsed object inv (preserves getEvent behaviour)', () => {
    // getEvent indexed `raw.inv?.[0]?.comp?.[0]` without firstOf, so an object
    // `inv` fell through to the top-level at[] leg. Reproduced deliberately —
    // "fixing" it here would change which attendee list the REST response
    // returns. See the note on mapZimbraAppointmentDetail.
    const d = mapZimbraAppointmentDetail({
      id: '401',
      inv: { id: '512', comp: [{ at: [{ a: 'from-comp@risa.gov.rw' }] }] },
      at: [{ a: 'from-top@risa.gov.rw' }],
    } as any);
    expect(d.attendees).toEqual([{ email: 'from-top@risa.gov.rw', name: undefined, ptst: undefined }]);
  });
});

describe('mapZimbraFreeBusy', () => {
  it('normalises the busy/tentative/unavailable slot arrays to numeric {s,e} pairs', () => {
    expect(mapZimbraFreeBusy({
      b: [{ s: '1000', e: '2000' }],
      t: [{ s: 3000, e: 4000 }],
      u: [{ s: 5000, e: 6000 }],
    } as any)).toEqual({
      busy: [{ s: 1000, e: 2000 }],
      tentative: [{ s: 3000, e: 4000 }],
      unavailable: [{ s: 5000, e: 6000 }],
    });
  });

  it('returns empty arrays for absent or non-array legs', () => {
    expect(mapZimbraFreeBusy({} as any)).toEqual({ busy: [], tentative: [], unavailable: [] });
    expect(mapZimbraFreeBusy({ b: {} } as any).busy).toEqual([]);
  });
});

// createCalendarEvent and modifyCalendarEvent built byte-identical `m` nodes
// from two verbatim copies of the same code. Hoisted into one reverse mapper;
// this test pins the request body so the hoist cannot drift it.
describe('mapCalendarEventPayloadToZimbraMessage', () => {
  it('builds the CreateAppointmentRequest `m` node with organizer, attendees and UTC times', () => {
    const m = mapCalendarEventPayloadToZimbraMessage({
      title: 'Working session with COK',
      location: 'KG1 Roundabout',
      startAt: new Date(Date.UTC(2026, 8, 10, 8, 30)),
      endAt: new Date(Date.UTC(2026, 8, 10, 9, 30)),
      allDay: false,
      description: 'Agenda: processes automation',
      organizerEmail: 'bruce.higiro@risa.gov.rw',
      organizerName: 'Bruce',
      attendees: ['alice@risa.gov.rw'],
    });

    expect(m).toEqual({
      su: 'Working session with COK',
      // 'f' = from (organizer); 't' = to (each attendee gets an invite email)
      e: [
        { t: 'f', a: 'bruce.higiro@risa.gov.rw', p: 'Bruce' },
        { t: 't', a: 'alice@risa.gov.rw' },
      ],
      inv: {
        comp: [{
          name: 'Working session with COK',
          loc: 'KG1 Roundabout',
          allDay: 0,
          fb: 'B',
          transp: 'O',
          s: { d: '20260910T083000Z' },
          e: { d: '20260910T093000Z' },
          or: { a: 'bruce.higiro@risa.gov.rw', p: 'Bruce' },
          at: [{ a: 'alice@risa.gov.rw', role: 'REQ', ptst: 'NE', rsvp: 1 }],
          desc: { _content: 'Agenda: processes automation' },
        }],
      },
    });
  });

  it('uses the date-only form for all-day events and omits at/desc/organizer name when absent', () => {
    const m = mapCalendarEventPayloadToZimbraMessage({
      title: 'Public holiday',
      startAt: new Date(Date.UTC(2026, 0, 1, 0, 0)),
      endAt: new Date(Date.UTC(2026, 0, 2, 0, 0)),
      allDay: true,
      organizerEmail: 'bruce.higiro@risa.gov.rw',
    });

    const comp = (m.inv.comp as any[])[0];
    expect(comp.s).toEqual({ d: '20260101' });
    expect(comp.e).toEqual({ d: '20260102' });
    expect(comp.allDay).toBe(1);
    expect(comp.loc).toBe('');
    expect(comp.or).toEqual({ a: 'bruce.higiro@risa.gov.rw' });
    expect(comp).not.toHaveProperty('at');
    expect(comp).not.toHaveProperty('desc');
    expect(m.e).toEqual([{ t: 'f', a: 'bruce.higiro@risa.gov.rw' }]);
  });
});
