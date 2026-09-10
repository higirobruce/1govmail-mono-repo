import { readFileSync } from 'fs';
import { join } from 'path';
import { EwsService } from './ews.service';
import { MailSession } from '../provider/mail-session';

/**
 * Task 6 — EWS contacts, GAL, calendar, free/busy. Each op runs through a fake
 * transport replaying recorded response fixtures in order, recording every
 * outbound envelope so both request construction and the neutral return value
 * can be asserted.
 */

const KEY = 'test-mail-cred-key-0123456789abcdef';
const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');

const FIND_CONTACTS = fixture('findcontacts.success.xml');
const CREATE_CONTACT = fixture('createcontact.success.xml');
const GET_CONTACT_CK = fixture('getcontact-changekey.success.xml');
const UPDATE_CONTACT = fixture('updatecontact.success.xml');
const MOVE_ITEM = fixture('moveitem.success.xml');
const RESOLVE_FULL = fixture('resolvenames-full.success.xml');
const RESOLVE_ERROR = fixture('resolvenames.error.xml');
const FIND_CALENDAR = fixture('findcalendar.success.xml');
const GET_APPT = fixture('getappointment.success.xml');
const GET_APPT_NOTFOUND = fixture('getappointment.notfound.xml');
const CREATE_CAL = fixture('createcalendar.success.xml');
const GET_APPT_CK = fixture('getappt-changekey.success.xml');
const UPDATE_CAL = fixture('updatecalendar.success.xml');
const DELETE_ITEM = fixture('deleteitem.success.xml');
const INVITE_REPLY = fixture('invitereply.success.xml');
const GET_AVAILABILITY = fixture('getuseravailability.success.xml');
const GET_AVAILABILITY_FAULT = fixture('getuseravailability.fault.xml');

/** Replays `script` entries in order (last one repeats), recording every
 *  outbound body so envelope construction + call order can be asserted. */
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

describe('EwsService contacts, GAL, calendar, free/busy (Task 6)', () => {
  const ORIGINAL = process.env.MAIL_CRED_KEY;
  beforeEach(() => { process.env.MAIL_CRED_KEY = KEY; });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MAIL_CRED_KEY;
    else process.env.MAIL_CRED_KEY = ORIGINAL;
  });

  // ── contacts ───────────────────────────────────────────────────────────────

  describe('getContacts', () => {
    it('issues a FindItem on the contacts folder', async () => {
      const { t, svc } = svcWith(FIND_CONTACTS);
      await svc.getContacts(SESSION);
      expect(t.calls[0].body).toContain('<m:FindItem Traversal="Shallow">');
      expect(t.calls[0].body).toContain('<t:DistinguishedFolderId Id="contacts"/>');
    });

    it('maps GivenName/Surname/DisplayName/company/jobTitle and role-tagged emails/phones', async () => {
      const { svc } = svcWith(FIND_CONTACTS);
      const contacts = await svc.getContacts(SESSION);
      expect(contacts).toHaveLength(2);

      const [alice, bob] = contacts;
      expect(alice.id).toBe('CONTACT-1==');
      expect(alice.displayName).toBe('Alice Umutoni');
      expect(alice.firstName).toBe('Alice');
      expect(alice.lastName).toBe('Umutoni');
      expect(alice.company).toBe('MINAFFET');
      expect(alice.jobTitle).toBe('Director');
      expect(alice.emails).toEqual([
        { email: 'alice.umutoni@minaffet.gov.rw', type: 'work', primary: true },
        { email: 'alice.personal@example.com', type: 'personal' },
      ]);
      expect(alice.phones).toEqual([
        { number: '+250788000001', type: 'work' },
        { number: '+250788000002', type: 'mobile' },
      ]);

      expect(bob.id).toBe('CONTACT-2==');
      expect(bob.emails).toEqual([
        { email: 'bob.mugisha@minaffet.gov.rw', type: 'work', primary: true },
      ]);
      expect(bob.phones).toEqual([]);
    });
  });

  describe('createContact', () => {
    it('issues CreateItem(Contact) and returns the input echoed back with the server id', async () => {
      const { t, svc } = svcWith(CREATE_CONTACT);
      const input = {
        displayName: 'Carol Kaze',
        firstName: 'Carol',
        lastName: 'Kaze',
        company: 'RISA',
        emails: [{ email: 'carol@risa.gov.rw', type: 'work', primary: true }],
        phones: [{ number: '+250780000000', type: 'mobile' }],
      };
      const created = await svc.createContact(SESSION, input);

      const body = t.calls[0].body;
      expect(body).toContain('<m:CreateItem>');
      expect(body).toContain('<t:DistinguishedFolderId Id="contacts"/>');
      expect(body).toContain('<t:Contact>');
      expect(body).toContain('<t:DisplayName>Carol Kaze</t:DisplayName>');
      expect(body).toContain('<t:GivenName>Carol</t:GivenName>');
      expect(body).toContain('<t:Surname>Kaze</t:Surname>');
      expect(body).toContain('<t:CompanyName>RISA</t:CompanyName>');
      expect(body).toContain('<t:Entry Key="EmailAddress1">carol@risa.gov.rw</t:Entry>');
      expect(body).toContain('<t:Entry Key="MobilePhone">+250780000000</t:Entry>');

      expect(created.id).toBe('CONTACT-NEW==');
      expect(created.displayName).toBe('Carol Kaze');
      expect(created.emails).toEqual(input.emails);
      expect(created.phones).toEqual(input.phones);
    });
  });

  describe('modifyContact', () => {
    it('reads a fresh ChangeKey with GetItem BEFORE the UpdateItem write', async () => {
      const { t, svc } = svcWith(GET_CONTACT_CK, UPDATE_CONTACT);
      await svc.modifyContact(SESSION, 'CONTACT-1==', { company: 'New Corp' });

      expect(t.calls).toHaveLength(2);
      expect(t.calls[0].body).toContain('<m:GetItem>');
      expect(t.calls[0].body).toContain('<t:BaseShape>IdOnly</t:BaseShape>');
      expect(t.calls[0].body).not.toContain('UpdateItem');
      expect(t.calls[1].body).toContain('<m:UpdateItem');
      // the UpdateItem carries the change key just read, never a cached one
      expect(t.calls[1].body).toContain('ChangeKey="FRESH-CCK-9"');
      expect(t.calls[1].body).toContain('<t:CompanyName>New Corp</t:CompanyName>');
    });
  });

  describe('deleteContact', () => {
    it('soft-deletes via MoveItem to deleteditems', async () => {
      const { t, svc } = svcWith(MOVE_ITEM);
      await expect(svc.deleteContact(SESSION, 'CONTACT-1==')).resolves.toBeUndefined();
      expect(t.calls[0].body).toContain('<m:MoveItem>');
      expect(t.calls[0].body).toContain('<t:DistinguishedFolderId Id="deleteditems"/>');
      expect(t.calls[0].body).toContain('<t:ItemId Id="CONTACT-1=="/>');
    });
  });

  // ── GAL / autocomplete (one ResolveNames op behind both) ────────────────────

  describe('autoCompleteContacts + searchGal', () => {
    it('resolves names to {email, display} via ResolveNames (ReturnFullContactData, ActiveDirectoryContacts)', async () => {
      const { t, svc } = svcWith(RESOLVE_FULL);
      const out = await svc.autoCompleteContacts(SESSION, 'alice');
      expect(t.calls[0].body).toContain('<m:ResolveNames ReturnFullContactData="true" SearchScope="ActiveDirectoryContacts">');
      expect(t.calls[0].body).toContain('<m:UnresolvedEntry>alice</m:UnresolvedEntry>');
      expect(out).toEqual([
        { email: 'alice.umutoni@minaffet.gov.rw', display: 'Alice Umutoni' },
        { email: 'alice.kabera@minaffet.gov.rw', display: 'Alice Kabera' },
      ]);
    });

    it('searchGal is served by the SAME ResolveNames op and returns the same shape', async () => {
      const { t, svc } = svcWith(RESOLVE_FULL);
      const out = await svc.searchGal(SESSION, 'alice');
      expect(t.calls[0].body).toContain('<m:ResolveNames');
      expect(out).toEqual([
        { email: 'alice.umutoni@minaffet.gov.rw', display: 'Alice Umutoni' },
        { email: 'alice.kabera@minaffet.gov.rw', display: 'Alice Kabera' },
      ]);
    });

    it('returns [] for a blank query without hitting the transport', async () => {
      const { t, svc } = svcWith(RESOLVE_FULL);
      expect(await svc.autoCompleteContacts(SESSION, '   ')).toEqual([]);
      expect(await svc.searchGal(SESSION, '')).toEqual([]);
      expect(t.calls).toHaveLength(0);
    });

    it('NEVER throws — a ResolveNames Error degrades to [] (both methods)', async () => {
      const auto = svcWith(RESOLVE_ERROR);
      await expect(auto.svc.autoCompleteContacts(SESSION, 'alice')).resolves.toEqual([]);
      const gal = svcWith(RESOLVE_ERROR);
      await expect(gal.svc.searchGal(SESSION, 'alice')).resolves.toEqual([]);
    });
  });

  // ── calendar ────────────────────────────────────────────────────────────────

  describe('getCalendarEvents', () => {
    it('issues a FindItem CalendarView over the window on the calendar folder', async () => {
      const { t, svc } = svcWith(FIND_CALENDAR);
      const start = Date.UTC(2026, 8, 15, 0, 0, 0);
      const end = Date.UTC(2026, 8, 18, 0, 0, 0);
      await svc.getCalendarEvents(SESSION, start, end);
      const body = t.calls[0].body;
      expect(body).toContain('<t:DistinguishedFolderId Id="calendar"/>');
      expect(body).toContain(`<m:CalendarView StartDate="${new Date(start).toISOString()}" EndDate="${new Date(end).toISOString()}"/>`);
    });

    it('maps expanded occurrences to ProviderEvent[] incl. the all-day flag', async () => {
      const { svc } = svcWith(FIND_CALENDAR);
      const events = await svc.getCalendarEvents(SESSION, 0, 1);
      expect(events).toHaveLength(2);

      const [timed, allDay] = events;
      expect(timed.id).toBe('APPT-1==');
      expect(timed.title).toBe('Budget review');
      expect(timed.location).toBe('Room 3A');
      expect(timed.startAt.toISOString()).toBe('2026-09-15T09:00:00.000Z');
      expect(timed.endAt.toISOString()).toBe('2026-09-15T10:00:00.000Z');
      expect(timed.allDay).toBe(false);
      expect(timed.isRecurring).toBe(false);
      expect(timed.organizer).toEqual({ email: 'test-risa1@minaffet.gov.rw', name: 'Test Risa' });
      expect(timed.attendees).toEqual([]);
      expect(timed.inviteId).toBeNull();

      expect(allDay.id).toBe('APPT-2==');
      expect(allDay.allDay).toBe(true);
      expect(allDay.isRecurring).toBe(true);
      expect(allDay.location).toBeNull();
    });
  });

  describe('getAppointment', () => {
    it('issues a GetItem requesting the attendee lists', async () => {
      const { t, svc } = svcWith(GET_APPT);
      await svc.getAppointment(SESSION, 'APPT-1==');
      const body = t.calls[0].body;
      expect(body).toContain('<m:GetItem>');
      expect(body).toContain('<t:FieldURI FieldURI="calendar:RequiredAttendees"/>');
      expect(body).toContain('<t:FieldURI FieldURI="calendar:OptionalAttendees"/>');
      expect(body).toContain('<t:ItemId Id="APPT-1=="/>');
    });

    it('maps RequiredAttendees + OptionalAttendees ResponseType to ptst, with the organizer', async () => {
      const { svc } = svcWith(GET_APPT);
      const detail = await svc.getAppointment(SESSION, 'APPT-1==');
      expect(detail).not.toBeNull();
      expect(detail!.id).toBe('APPT-1==');
      expect(detail!.organizer).toEqual({ email: 'test-risa1@minaffet.gov.rw', name: 'Test Risa' });
      expect(detail!.attendees).toEqual([
        { email: 'alice.umutoni@minaffet.gov.rw', name: 'Alice Umutoni', ptst: 'AC' },
        { email: 'bob.mugisha@minaffet.gov.rw', name: 'Bob Mugisha', ptst: 'NE' },
        { email: 'carol.n@minaffet.gov.rw', name: 'Carol Ndayambaje', ptst: 'TE' },
      ]);
      expect(detail!.inviteMessageId).toBeNull();
    });

    it('returns null (NOT NotFoundException) for an unknown id', async () => {
      const { svc } = svcWith(GET_APPT_NOTFOUND);
      await expect(svc.getAppointment(SESSION, 'nope==')).resolves.toBeNull();
    });
  });

  describe('createCalendarEvent', () => {
    it('sends a timed CalendarItem with SendToAllAndSaveCopy and returns the new id', async () => {
      const { t, svc } = svcWith(CREATE_CAL);
      const id = await svc.createCalendarEvent(SESSION, {
        title: 'Sync',
        location: 'Room 1',
        startAt: new Date('2026-09-15T09:00:00Z'),
        endAt: new Date('2026-09-15T09:30:00Z'),
        allDay: false,
        organizerEmail: 'test-risa1@minaffet.gov.rw',
        attendees: ['alice.umutoni@minaffet.gov.rw'],
      });
      const body = t.calls[0].body;
      expect(body).toContain('<m:CreateItem SendMeetingInvitations="SendToAllAndSaveCopy">');
      expect(body).toContain('<t:DistinguishedFolderId Id="calendar"/>');
      expect(body).toContain('<t:Subject>Sync</t:Subject>');
      expect(body).toContain('<t:Start>2026-09-15T09:00:00Z</t:Start>');
      expect(body).toContain('<t:End>2026-09-15T09:30:00Z</t:End>');
      expect(body).toContain('<t:Location>Room 1</t:Location>');
      expect(body).toContain('<t:RequiredAttendees><t:Attendee><t:Mailbox><t:EmailAddress>alice.umutoni@minaffet.gov.rw</t:EmailAddress></t:Mailbox></t:Attendee></t:RequiredAttendees>');
      expect(body).not.toContain('<t:IsAllDayEvent>');
      expect(id).toBe('APPT-NEW==');
    });

    it('emits date-only UTC boundaries and IsAllDayEvent for an all-day event', async () => {
      const { t, svc } = svcWith(CREATE_CAL);
      await svc.createCalendarEvent(SESSION, {
        title: 'Holiday',
        startAt: new Date('2026-09-16T00:00:00Z'),
        endAt: new Date('2026-09-17T00:00:00Z'),
        allDay: true,
        organizerEmail: 'test-risa1@minaffet.gov.rw',
      });
      const body = t.calls[0].body;
      expect(body).toContain('<t:Start>2026-09-16T00:00:00Z</t:Start>');
      expect(body).toContain('<t:End>2026-09-17T00:00:00Z</t:End>');
      expect(body).toContain('<t:IsAllDayEvent>true</t:IsAllDayEvent>');
      // the boundaries are date-only UTC midnight — no non-zero time-of-day slips in
      expect(body).toMatch(/<t:Start>2026-09-16T00:00:00Z<\/t:Start>/);
      expect(body).not.toMatch(/<t:Start>\d{4}-\d\d-\d\dT(?!00:00:00Z)/);
    });
  });

  describe('modifyCalendarEvent', () => {
    it('reads a fresh ChangeKey then UpdateItem with SendMeetingInvitationsOrCancellations', async () => {
      const { t, svc } = svcWith(GET_APPT_CK, UPDATE_CAL);
      await svc.modifyCalendarEvent(SESSION, 'APPT-1==', {
        title: 'Sync v2',
        startAt: new Date('2026-09-15T10:00:00Z'),
        endAt: new Date('2026-09-15T10:30:00Z'),
        allDay: false,
        organizerEmail: 'test-risa1@minaffet.gov.rw',
      });
      expect(t.calls).toHaveLength(2);
      expect(t.calls[0].body).toContain('<m:GetItem>');
      expect(t.calls[0].body).not.toContain('UpdateItem');
      expect(t.calls[1].body).toContain('<m:UpdateItem ConflictResolution="AlwaysOverwrite" SendMeetingInvitationsOrCancellations="SendToAllAndSaveCopy">');
      expect(t.calls[1].body).toContain('ChangeKey="FRESH-ACK-9"');
      expect(t.calls[1].body).toContain('<t:Subject>Sync v2</t:Subject>');
    });
  });

  describe('deleteCalendarEvent', () => {
    it('issues DeleteItem MoveToDeletedItems with SendMeetingCancellations', async () => {
      const { t, svc } = svcWith(DELETE_ITEM);
      await expect(svc.deleteCalendarEvent(SESSION, 'APPT-1==')).resolves.toBeUndefined();
      const body = t.calls[0].body;
      expect(body).toContain('<m:DeleteItem DeleteType="MoveToDeletedItems" SendMeetingCancellations="SendToAllAndSaveCopy">');
      expect(body).toContain('<t:ItemId Id="APPT-1=="/>');
    });
  });

  describe('sendInviteReply', () => {
    it('builds AcceptItem for ACCEPT', async () => {
      const { t, svc } = svcWith(INVITE_REPLY);
      await svc.sendInviteReply(SESSION, 'INVITE-1==', 'ACCEPT');
      const body = t.calls[0].body;
      expect(body).toContain('<m:CreateItem MessageDisposition="SendAndSaveCopy">');
      expect(body).toContain('<t:AcceptItem><t:ReferenceItemId Id="INVITE-1=="/></t:AcceptItem>');
    });

    it('builds DeclineItem for DECLINE', async () => {
      const { t, svc } = svcWith(INVITE_REPLY);
      await svc.sendInviteReply(SESSION, 'INVITE-1==', 'DECLINE');
      expect(t.calls[0].body).toContain('<t:DeclineItem>');
    });

    it('builds TentativelyAcceptItem for TENTATIVE', async () => {
      const { t, svc } = svcWith(INVITE_REPLY);
      await svc.sendInviteReply(SESSION, 'INVITE-1==', 'TENTATIVE');
      expect(t.calls[0].body).toContain('<t:TentativelyAcceptItem>');
    });
  });

  // ── free / busy ─────────────────────────────────────────────────────────────

  describe('getFreeBusy', () => {
    it('issues GetUserAvailability FreeBusy for the mailbox over the window', async () => {
      const { t, svc } = svcWith(GET_AVAILABILITY);
      const start = Date.UTC(2026, 8, 15, 0, 0, 0);
      const end = Date.UTC(2026, 8, 16, 0, 0, 0);
      await svc.getFreeBusy(SESSION, 'alice.umutoni@minaffet.gov.rw', start, end);
      const body = t.calls[0].body;
      expect(body).toContain('<m:GetUserAvailabilityRequest>');
      expect(body).toContain('<t:RequestedView>FreeBusy</t:RequestedView>');
      expect(body).toContain('<t:Address>alice.umutoni@minaffet.gov.rw</t:Address>');
      // TimeWindow must be UNQUALIFIED yyyy-MM-ddTHH:mm:ss — no 'Z', no
      // milliseconds (a Z/ms-bearing ISO value faults the request generically)
      expect(body).toContain('<t:StartTime>2026-09-15T00:00:00</t:StartTime>');
      expect(body).toContain('<t:EndTime>2026-09-16T00:00:00</t:EndTime>');
      const window = body.slice(body.indexOf('<t:TimeWindow>'), body.indexOf('</t:TimeWindow>'));
      expect(window).not.toContain('Z<');
      expect(window).not.toMatch(/\.\d{3}/);
    });

    it('surfaces a GetUserAvailability fault with its MessageText, not a bare .NET code', async () => {
      const { svc } = svcWith(GET_AVAILABILITY_FAULT);
      // the generic fault code (a:-2146233088) alone is useless; the human-
      // readable MessageText must reach the surfaced error
      await expect(
        svc.getFreeBusy(SESSION, 'ghost@minaffet.gov.rw', 0, 1),
      ).rejects.toThrow(/Cannot determine free\/busy status/);
    });

    it('folds CalendarEvent BusyType into the {busy, tentative, unavailable} triple (Free dropped)', async () => {
      const { svc } = svcWith(GET_AVAILABILITY);
      const fb = await svc.getFreeBusy(SESSION, 'alice.umutoni@minaffet.gov.rw', 0, 1);
      expect(fb.busy).toEqual([
        { s: Date.parse('2026-09-15T09:00:00Z'), e: Date.parse('2026-09-15T10:00:00Z') },
      ]);
      expect(fb.tentative).toEqual([
        { s: Date.parse('2026-09-15T11:00:00Z'), e: Date.parse('2026-09-15T11:30:00Z') },
      ]);
      expect(fb.unavailable).toEqual([
        { s: Date.parse('2026-09-15T14:00:00Z'), e: Date.parse('2026-09-15T15:00:00Z') },
      ]);
    });
  });
});
