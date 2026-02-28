import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';

export interface CalendarEventData {
  title: string;
  description?: string;
  location?: string;
  startAt: string;  // ISO string
  endAt: string;    // ISO string
  allDay?: boolean;
  attendees?: string[];
}

@Injectable()
export class CalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly zimbra: ZimbraService,
  ) {}

  private async getUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.authToken)
      throw new UnauthorizedException('Please log in again to connect to Zimbra.');
    return user;
  }

  /** Parse a raw Zimbra appointment node into a structured event. */
  private parseAppt(appt: any): {
    zimbraId: string;
    title: string;
    description: string | null;
    location: string | null;
    startAt: Date;
    endAt: Date;
    allDay: boolean;
    isRecurring: boolean;
    organizer: string | null;
    attendees: Array<{ email: string; name?: string }>;
  } | null {
    // Appointments may have multiple instances; use the first expanded instance
    const inst = Array.isArray(appt.inst) ? appt.inst[0] : null;
    if (!inst) return null;

    const startMs: number = inst.s ?? 0;
    const dur: number = inst.dur ?? 3_600_000;
    const allDay = !!(inst.allDay || appt.allDay);

    return {
      zimbraId: String(appt.id),
      title: appt.name ?? appt.su ?? '(No title)',
      description: appt.desc ?? null,
      location: appt.loc ?? null,
      startAt: new Date(startMs),
      endAt: new Date(startMs + dur),
      allDay,
      isRecurring: !!(appt.recur),
      organizer: appt.or?.a ?? null,
      attendees: Array.isArray(appt.at)
        ? appt.at.map((a: any) => ({ email: a.a, name: a.d ?? undefined }))
        : [],
    };
  }

  // ── Get events for a date range ───────────────────────────────────────────

  async getEvents(userId: string, start: Date, end: Date): Promise<any[]> {
    const user = await this.getUser(userId);
    const rawAppts = await this.zimbra.getCalendarEvents(
      user.zimbraHost,
      user.authToken!,
      start.getTime(),
      end.getTime(),
      user.csrfToken ?? undefined,
    );

    const results: any[] = [];
    for (const appt of rawAppts) {
      const parsed = this.parseAppt(appt);
      if (!parsed) continue;

      const cached = await this.prisma.calendarEvent.upsert({
        where: { userId_zimbraId: { userId, zimbraId: parsed.zimbraId } },
        create: {
          userId,
          zimbraId:     parsed.zimbraId,
          title:        parsed.title,
          description:  parsed.description,
          location:     parsed.location,
          startAt:      parsed.startAt,
          endAt:        parsed.endAt,
          allDay:       parsed.allDay,
          isRecurring:  parsed.isRecurring,
          organizer:    parsed.organizer,
          attendees:    parsed.attendees as any,
          syncedAt:     new Date(),
        },
        update: {
          title:        parsed.title,
          description:  parsed.description,
          location:     parsed.location,
          startAt:      parsed.startAt,
          endAt:        parsed.endAt,
          allDay:       parsed.allDay,
          isRecurring:  parsed.isRecurring,
          organizer:    parsed.organizer,
          attendees:    parsed.attendees as any,
          syncedAt:     new Date(),
        },
      });
      results.push(cached);
    }
    return results;
  }

  // ── Create event ──────────────────────────────────────────────────────────

  async createEvent(userId: string, data: CalendarEventData): Promise<any> {
    const user = await this.getUser(userId);
    const startAt = new Date(data.startAt);
    const endAt   = new Date(data.endAt);

    const zimbraId = await this.zimbra.createCalendarEvent(
      user.zimbraHost,
      user.authToken!,
      {
        title:          data.title,
        location:       data.location,
        startAt,
        endAt,
        allDay:         data.allDay ?? false,
        description:    data.description,
        organizerEmail: user.email,
        organizerName:  user.displayName ?? undefined,
        attendees:      data.attendees ?? [],
      },
      user.csrfToken ?? undefined,
    );

    return this.prisma.calendarEvent.create({
      data: {
        userId,
        zimbraId:    zimbraId || `local-${Date.now()}`,
        title:       data.title,
        description: data.description ?? null,
        location:    data.location    ?? null,
        startAt,
        endAt,
        allDay:      data.allDay ?? false,
        isRecurring: false,
        organizer:   user.email,
        attendees:   (data.attendees ?? []).map((a) => ({ email: a })) as any,
        syncedAt:    new Date(),
      },
    });
  }

  // ── Update event ──────────────────────────────────────────────────────────

  async updateEvent(userId: string, eventId: string, data: CalendarEventData): Promise<any> {
    const user = await this.getUser(userId);
    const event = await this.prisma.calendarEvent.findFirst({
      where: { id: eventId, userId },
    });
    if (!event) throw new NotFoundException('Event not found');

    const startAt = new Date(data.startAt);
    const endAt   = new Date(data.endAt);

    await this.zimbra.modifyCalendarEvent(
      user.zimbraHost,
      user.authToken!,
      event.zimbraId,
      {
        title:          data.title,
        location:       data.location,
        startAt,
        endAt,
        allDay:         data.allDay ?? false,
        description:    data.description,
        organizerEmail: user.email,
        organizerName:  user.displayName ?? undefined,
        attendees:      data.attendees ?? [],
      },
      user.csrfToken ?? undefined,
    );

    return this.prisma.calendarEvent.update({
      where: { id: eventId },
      data: {
        title:       data.title,
        description: data.description ?? null,
        location:    data.location    ?? null,
        startAt,
        endAt,
        allDay:      data.allDay ?? false,
        attendees:   (data.attendees ?? []).map((a) => ({ email: a })) as any,
        syncedAt:    new Date(),
      },
    });
  }

  // ── Delete event ──────────────────────────────────────────────────────────

  async deleteEvent(
    userId: string,
    eventId: string,
  ): Promise<{ success: boolean }> {
    const user = await this.getUser(userId);
    const event = await this.prisma.calendarEvent.findFirst({
      where: { id: eventId, userId },
    });
    if (!event) throw new NotFoundException('Event not found');

    await this.zimbra.deleteCalendarEvent(
      user.zimbraHost,
      user.authToken!,
      event.zimbraId,
      user.csrfToken ?? undefined,
    );
    await this.prisma.calendarEvent.delete({ where: { id: eventId } });
    return { success: true };
  }

  // ── RSVP ─────────────────────────────────────────────────────────────────

  async rsvpEvent(
    userId: string,
    eventId: string,
    verb: 'ACCEPT' | 'DECLINE' | 'TENTATIVE',
  ): Promise<{ success: boolean }> {
    const user = await this.getUser(userId);
    const event = await this.prisma.calendarEvent.findFirst({
      where: { id: eventId, userId },
    });
    if (!event) throw new NotFoundException('Event not found');

    await this.zimbra.sendInviteReply(
      user.zimbraHost,
      user.authToken!,
      event.zimbraId,
      verb,
      event.title,
      user.csrfToken ?? undefined,
    );
    return { success: true };
  }

  // ── Free / Busy ───────────────────────────────────────────────────────────

  /**
   * Return the free/busy schedule for another user on the same Zimbra server.
   * The result contains busy, tentative, and unavailable slot arrays as
   * millisecond timestamp pairs { s, e }.
   */
  async getFreeBusy(
    userId: string,
    email: string,
    start: Date,
    end: Date,
  ): Promise<{
    email: string;
    busy:        Array<{ s: number; e: number }>;
    tentative:   Array<{ s: number; e: number }>;
    unavailable: Array<{ s: number; e: number }>;
  }> {
    const user = await this.getUser(userId);
    const data = await this.zimbra.getFreeBusy(
      user.zimbraHost,
      user.authToken!,
      email,
      start.getTime(),
      end.getTime(),
      user.csrfToken ?? undefined,
    );
    return { email, ...data };
  }

  // ── Batch Free / Busy ─────────────────────────────────────────────────────

  /**
   * Return free/busy for multiple users in parallel (one Zimbra call per email).
   */
  async getFreeBusyBatch(
    userId: string,
    emails: string[],
    start: Date,
    end: Date,
  ): Promise<Array<{
    email: string;
    busy:        Array<{ s: number; e: number }>;
    tentative:   Array<{ s: number; e: number }>;
    unavailable: Array<{ s: number; e: number }>;
  }>> {
    const user = await this.getUser(userId);
    return Promise.all(
      emails.map((email) =>
        this.zimbra
          .getFreeBusy(
            user.zimbraHost,
            user.authToken!,
            email,
            start.getTime(),
            end.getTime(),
            user.csrfToken ?? undefined,
          )
          .then((data) => ({ email, ...data })),
      ),
    );
  }
}
