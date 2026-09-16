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

    await service.getEvents('u1', Date.parse('2026-09-01'), Date.parse('2026-09-30'));

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

    await service.getEvent('u1', 'e1');

    const data = prisma.calendarEvent.update.mock.calls[0][0].data;
    expect(data.icalUid).toBeUndefined();   // undefined means "leave unchanged" in Prisma
  });
});
