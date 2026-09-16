import { NotFoundException } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { MailProviderResolver } from '../provider/mail-provider.resolver';
import { DocsService } from '../docs/docs.service';

/** `provider` is what MailProviderResolver.forUser reads — the DB always
 *  carries it, so the fixture must too or the resolver rejects the user. */
export const USER = {
  id: 'u1', email: 'me@risa.gov.rw', authToken: 'tok',
  tokenExpiry: new Date(Date.now() + 60_000), provider: 'zimbra',
};

export const zimbraStub = {
  getCalendarEvents: jest.fn(),
  getAppointment: jest.fn(),
};

export function makeService() {
  jest.clearAllMocks();
  const prisma = {
    user: { findUnique: jest.fn() },
    calendarEvent: {
      findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({ id: 'e1' }), update: jest.fn(),
    },
    meetingMinutes: { findUnique: jest.fn().mockResolvedValue(null) },
  } as unknown as PrismaService;
  const docs = { createMinutesDocument: jest.fn() } as unknown as DocsService;
  const service = new CalendarService(
    prisma,
    new MailProviderResolver(zimbraStub as unknown as ZimbraService),
    docs,
  );
  return { service, prisma: prisma as any, docs: docs as any };
}

describe('CalendarService icalUid persistence', () => {
  it('stores the UID from a list sync', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    zimbraStub.getCalendarEvents.mockResolvedValue([
      { id: 'z-1', title: 'Cabinet briefing', startAt: new Date('2026-09-17T09:00:00Z'),
        endAt: new Date('2026-09-17T10:00:00Z'), allDay: false, attendees: [],
        inviteId: null, isRecurring: false, icalUid: 'cabinet@zimbra' },
    ]);

    await service.getEvents('u1', new Date('2026-09-01'), new Date('2026-09-30'));

    expect(prisma.calendarEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ icalUid: 'cabinet@zimbra' }),
        update: expect.objectContaining({ icalUid: 'cabinet@zimbra' }),
      }),
    );
  });

  it('fills the UID from the detail fetch when the list did not carry one', async () => {
    // This is the Zimbra fallback path: some versions omit uid on search but
    // always carry it on the appointment detail.
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.calendarEvent.findFirst.mockResolvedValue({ id: 'e1', zimbraId: 'z-1', icalUid: null });
    zimbraStub.getAppointment.mockResolvedValue({
      id: 'z-1', attendees: [{ email: 'a@risa.gov.rw' }],
      organizer: { email: 'chair@risa.gov.rw' }, icalUid: 'cabinet@zimbra',
    });
    // getEvent now reads the refreshed row's icalUid/startAt to resolve the
    // minutes link, so the update mock must resolve to a row, not undefined.
    prisma.calendarEvent.update.mockResolvedValue({
      id: 'e1', icalUid: 'cabinet@zimbra', startAt: new Date('2026-09-17T09:00:00Z'),
    });

    await service.getEvent('u1', 'e1');

    expect(prisma.calendarEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ icalUid: 'cabinet@zimbra' }) }),
    );
  });

  it('does not overwrite a stored UID with null when the detail omits it', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.calendarEvent.findFirst.mockResolvedValue({ id: 'e1', zimbraId: 'z-1', icalUid: 'kept@zimbra' });
    zimbraStub.getAppointment.mockResolvedValue({ id: 'z-1', attendees: [], organizer: null });
    // getEvent now reads the refreshed row's icalUid/startAt to resolve the
    // minutes link, so the update mock must resolve to a row, not undefined.
    prisma.calendarEvent.update.mockResolvedValue({
      id: 'e1', icalUid: 'kept@zimbra', startAt: new Date('2026-09-17T09:00:00Z'),
    });

    await service.getEvent('u1', 'e1');

    const data = prisma.calendarEvent.update.mock.calls[0][0].data;
    expect(data.icalUid).toBeUndefined();   // undefined means "leave unchanged" in Prisma
  });
});

describe('CalendarService.createMinutes', () => {
  const DTO = { title: 'Minutes — Cabinet briefing', content: '{"type":"doc","content":[]}' };

  it('delegates with the event\'s attendees, UID and its own start as the occurrence', async () => {
    const { service, prisma, docs } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.calendarEvent.findFirst.mockResolvedValue({
      id: 'e1', userId: 'u1', icalUid: 'cabinet@zimbra',
      startAt: new Date('2026-09-17T09:00:00Z'),
      attendees: ['a@risa.gov.rw', 'b@risa.gov.rw'],
    });
    docs.createMinutesDocument.mockResolvedValue({ documentId: 'doc-1', linked: true });

    const result = await service.createMinutes('u1', 'e1', DTO);

    expect(result).toEqual({ documentId: 'doc-1', linked: true });
    expect(docs.createMinutesDocument).toHaveBeenCalledWith('u1', {
      title: DTO.title,
      content: DTO.content,
      attendeeEmails: ['a@risa.gov.rw', 'b@risa.gov.rw'],
      icalUid: 'cabinet@zimbra',
      occurrenceStartAt: new Date('2026-09-17T09:00:00Z'),
    });
  });

  it('refuses an event that is not the caller\'s', async () => {
    const { service, prisma, docs } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.calendarEvent.findFirst.mockResolvedValue(null);

    await expect(service.createMinutes('u1', 'someone-elses', DTO)).rejects.toBeInstanceOf(NotFoundException);
    expect(docs.createMinutesDocument).not.toHaveBeenCalled();
  });

  it('extracts emails from object-shaped attendees — the shape both providers actually persist', async () => {
    // CalendarEvent.attendees is stored as `{email, name}[]` by both Zimbra
    // (zimbra.mappers.ts mapZimbraAppointment) and EWS (mapAttendeeContainer),
    // and that's the shape the web app's own event type expects back. A plain
    // `as string[]` cast on this column would hand DocsService raw objects.
    const { service, prisma, docs } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.calendarEvent.findFirst.mockResolvedValue({
      id: 'e1', userId: 'u1', icalUid: 'cabinet@zimbra',
      startAt: new Date('2026-09-17T09:00:00Z'),
      attendees: [{ email: 'a@risa.gov.rw', name: 'A' }, { email: 'b@risa.gov.rw' }],
    });
    docs.createMinutesDocument.mockResolvedValue({ documentId: 'doc-1', linked: true });

    await service.createMinutes('u1', 'e1', DTO);

    expect(docs.createMinutesDocument).toHaveBeenCalledWith('u1', expect.objectContaining({
      attendeeEmails: ['a@risa.gov.rw', 'b@risa.gov.rw'],
    }));
  });
});

describe('CalendarService.getEvent minutes link', () => {
  it('reports the minutes document for this occurrence', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.calendarEvent.findFirst.mockResolvedValue({
      id: 'e1', zimbraId: 'z-1', icalUid: 'cabinet@zimbra',
      startAt: new Date('2026-09-17T09:00:00Z'), attendees: [],
    });
    zimbraStub.getAppointment.mockResolvedValue({ id: 'z-1', attendees: [], organizer: null });
    // Prisma's update() without a `select` returns the complete row, so the
    // fake must carry icalUid too — a mock that omits a field the production
    // code reads is a wrong mock, not a smaller one.
    prisma.calendarEvent.update.mockResolvedValue({
      id: 'e1', icalUid: 'cabinet@zimbra', startAt: new Date('2026-09-17T09:00:00Z'),
    });
    prisma.meetingMinutes.findUnique.mockResolvedValue({ documentId: 'doc-1' });

    const event: any = await service.getEvent('u1', 'e1');

    expect(event.minutesDocumentId).toBe('doc-1');
  });

  it('reports null when this occurrence has no minutes', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.calendarEvent.findFirst.mockResolvedValue({
      id: 'e1', zimbraId: 'z-1', icalUid: 'cabinet@zimbra',
      startAt: new Date('2026-09-17T09:00:00Z'), attendees: [],
    });
    zimbraStub.getAppointment.mockResolvedValue({ id: 'z-1', attendees: [], organizer: null });
    prisma.calendarEvent.update.mockResolvedValue({
      id: 'e1', icalUid: 'cabinet@zimbra', startAt: new Date('2026-09-17T09:00:00Z'),
    });
    prisma.meetingMinutes.findUnique.mockResolvedValue(null);

    const event: any = await service.getEvent('u1', 'e1');

    expect(event.minutesDocumentId).toBeNull();
  });

  it('reports null without querying when the event has no UID', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.calendarEvent.findFirst.mockResolvedValue({
      id: 'e1', zimbraId: 'z-1', icalUid: null,
      startAt: new Date('2026-09-17T09:00:00Z'), attendees: [],
    });
    zimbraStub.getAppointment.mockResolvedValue({ id: 'z-1', attendees: [], organizer: null });
    prisma.calendarEvent.update.mockResolvedValue({
      id: 'e1', icalUid: null, startAt: new Date('2026-09-17T09:00:00Z'),
    });

    const event: any = await service.getEvent('u1', 'e1');

    expect(event.minutesDocumentId).toBeNull();
    expect(prisma.meetingMinutes.findUnique).not.toHaveBeenCalled();
  });

  it('reports the minutes document even when the provider detail fetch returns nothing', async () => {
    // The `!detail` early return must carry the same minutesDocumentId
    // resolution as the refreshed-row path — the response shape can't depend
    // on whether the upstream fetch happened to succeed.
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.calendarEvent.findFirst.mockResolvedValue({
      id: 'e1', zimbraId: 'z-1', icalUid: 'cabinet@zimbra',
      startAt: new Date('2026-09-17T09:00:00Z'), attendees: [],
    });
    zimbraStub.getAppointment.mockResolvedValue(null);
    prisma.meetingMinutes.findUnique.mockResolvedValue({ documentId: 'doc-1' });

    const event: any = await service.getEvent('u1', 'e1');

    expect(event.minutesDocumentId).toBe('doc-1');
    expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
  });

  it('reports null without querying on the early-return path when the event has no UID', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.calendarEvent.findFirst.mockResolvedValue({
      id: 'e1', zimbraId: 'z-1', icalUid: null,
      startAt: new Date('2026-09-17T09:00:00Z'), attendees: [],
    });
    zimbraStub.getAppointment.mockResolvedValue(null);

    const event: any = await service.getEvent('u1', 'e1');

    expect(event.minutesDocumentId).toBeNull();
    expect(prisma.meetingMinutes.findUnique).not.toHaveBeenCalled();
  });
});
