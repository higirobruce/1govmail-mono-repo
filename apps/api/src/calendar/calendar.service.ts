import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { buildMailSession } from '../provider/mail-session';
import { MailProviderResolver } from '../provider/mail-provider.resolver';
import { DocsService } from '../docs/docs.service';
import { CreateMinutesDto } from './dto/create-minutes.dto';

/**
 * `CalendarEvent.attendees` is a JSON column, and both providers persist it as
 * `{email, name}[]` (see zimbra.mappers.ts mapZimbraAppointment and
 * ews.service.ts mapAttendeeContainer) — never bare strings. Accept either
 * shape so a naive `string[]` assumption elsewhere can't silently hand a raw
 * attendee object downstream.
 */
function attendeeEmails(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) => (typeof a === 'string' ? a : (a as { email?: string } | null)?.email ?? ''))
    .filter((e): e is string => e.length > 0);
}

export interface CalendarEventData {
  title: string;
  description?: string;
  location?: string;
  startAt: string;  // ISO string
  endAt: string;    // ISO string
  allDay?: boolean;
  attendees?: string[];
  linkedMessageId?: string;
  linkedSubject?: string;
}

@Injectable()
export class CalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: MailProviderResolver,
    private readonly docs: DocsService,
  ) {}

  private async getUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.authToken)
      throw new UnauthorizedException('Please log in again to connect to Zimbra.');
    return user;
  }

  // ── Get events for a date range ───────────────────────────────────────────

  /**
   * Wire→app parsing of the appointment search hits (the `inst[]` expansion,
   * the title/loc/desc fallbacks, the attendee shape) now lives in
   * zimbra.mappers.mapZimbraAppointment. This method only caches what the
   * provider returned.
   */
  async getEvents(userId: string, start: Date, end: Date): Promise<any[]> {
    const user = await this.getUser(userId);
    const events = await this.resolver.forUser(user).getCalendarEvents(
      buildMailSession(user),
      start.getTime(),
      end.getTime(),
    );

    const results: any[] = [];
    for (const ev of events) {
      // `organizer` is an email column, so only the address survives; nulls are
      // written explicitly (not left undefined) so that clearing a field
      // upstream also clears the cached copy on update.
      const row = {
        zimbraInviteId: ev.inviteId,
        title:          ev.title,
        description:    ev.description ?? null,
        location:       ev.location ?? null,
        startAt:        ev.startAt,
        endAt:          ev.endAt,
        allDay:         ev.allDay,
        isRecurring:    ev.isRecurring,
        organizer:      ev.organizer?.email ?? null,
        attendees:      ev.attendees as any,
        icalUid:        ev.icalUid ?? null,
        syncedAt:       new Date(),
      };

      const cached = await this.prisma.calendarEvent.upsert({
        where: { userId_zimbraId: { userId, zimbraId: ev.id } },
        create: { userId, zimbraId: ev.id, ...row },
        update: row,
      });
      results.push(cached);
    }
    return results;
  }

  // ── Get single event (full detail from Zimbra) ────────────────────────────

  /**
   * Fetch full event details from Zimbra's GetAppointmentRequest, which always
   * returns the complete attendee list. The DB record is updated in-place so
   * subsequent calls can use the cache.
   */
  async getEvent(userId: string, eventId: string): Promise<any> {
    const user = await this.getUser(userId);
    const event = await this.prisma.calendarEvent.findFirst({
      where: { id: eventId, userId },
    });
    if (!event) throw new NotFoundException('Event not found');

    const detail = await this.resolver.forUser(user).getAppointment(buildMailSession(user), event.zimbraId);

    if (!detail) {
      return { ...event, minutesDocumentId: await this.resolveMinutesDocumentId(event) };
    }

    // A null attendee list means the response carried none at all — keep the
    // cached one rather than blanking it.
    const attendees = detail.attendees ?? ((event.attendees as any) ?? []);
    const organizer: string | null = detail.organizer?.email ?? event.organizer;

    // Persist the enriched attendees so the event list is also up to date
    const updated = await this.prisma.calendarEvent.update({
      where: { id: eventId },
      data: {
        attendees: attendees as any,
        organizer,
        // `undefined` means "leave unchanged" in Prisma; null would erase a UID
        // the list sync had already stored.
        ...(detail.icalUid ? { icalUid: detail.icalUid } : {}),
        syncedAt: new Date(),
      },
    });

    // The drawer needs this to choose between "Create minutes" and "Open
    // minutes", so it rides the detail response rather than costing a request.
    return { ...updated, minutesDocumentId: await this.resolveMinutesDocumentId(updated) };
  }

  /**
   * Resolve the MeetingMinutes link for one occurrence. `row` must be the row
   * about to be returned to the caller — never a stale pre-refresh copy — so
   * its `icalUid` and `startAt` are always from the same generation of the
   * event. No UID means no query and a null answer.
   */
  private async resolveMinutesDocumentId(row: { icalUid: string | null; startAt: Date }): Promise<string | null> {
    if (!row.icalUid) return null;
    const link = await this.prisma.meetingMinutes.findUnique({
      where: {
        icalUid_occurrenceStartAt: { icalUid: row.icalUid, occurrenceStartAt: row.startAt },
      },
      select: { documentId: true },
    });
    return link?.documentId ?? null;
  }

  // ── Create event ──────────────────────────────────────────────────────────

  async createEvent(userId: string, data: CalendarEventData): Promise<any> {
    const user = await this.getUser(userId);
    const startAt = new Date(data.startAt);
    const endAt   = new Date(data.endAt);

    const zimbraId = await this.resolver.forUser(user).createCalendarEvent(buildMailSession(user), {
      title:          data.title,
      location:       data.location,
      startAt,
      endAt,
      allDay:         data.allDay ?? false,
      description:    data.description,
      organizerEmail: user.email,
      organizerName:  user.displayName ?? undefined,
      attendees:      data.attendees ?? [],
    });

    return this.prisma.calendarEvent.create({
      data: {
        userId,
        zimbraId:        zimbraId || `local-${Date.now()}`,
        title:           data.title,
        description:     data.description ?? null,
        location:        data.location    ?? null,
        startAt,
        endAt,
        allDay:          data.allDay ?? false,
        isRecurring:     false,
        organizer:       user.email,
        attendees:       (data.attendees ?? []).map((a) => ({ email: a })) as any,
        linkedMessageId: data.linkedMessageId ?? null,
        linkedSubject:   data.linkedSubject   ?? null,
        syncedAt:        new Date(),
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

    // Fetch the current appointment to get the latest sequence number.
    // ModifyAppointmentRequest requires seq to match what's on the server;
    // sending an outdated seq results in the "The specified Invite is out of date" 502 error.
    const provider = this.resolver.forUser(user);
    const session = buildMailSession(user);
    const detail = await provider.getAppointment(session, event.zimbraId);

    // ModifyAppointmentRequest.id must be "{calItemId}-{invMsgId}", not just the
    // calItemId — the provider surfaces the invite half, we own the join.
    const modifyId = detail?.inviteMessageId
      ? `${event.zimbraId}-${detail.inviteMessageId}`
      : (event.zimbraInviteId ?? event.zimbraId);

    await provider.modifyCalendarEvent(session, modifyId, {
      title:             data.title,
      location:          data.location,
      startAt,
      endAt,
      allDay:            data.allDay ?? false,
      description:       data.description,
      organizerEmail:    user.email,
      organizerName:     user.displayName ?? undefined,
      attendees:         data.attendees ?? [],
      modifiedSequence:  detail?.modifiedSequence,
      rev:               detail?.rev,
    });

    return this.prisma.calendarEvent.update({
      where: { id: eventId },
      data: {
        title:           data.title,
        description:     data.description ?? null,
        location:        data.location    ?? null,
        startAt,
        endAt,
        allDay:          data.allDay ?? false,
        attendees:       (data.attendees ?? []).map((a) => ({ email: a })) as any,
        ...(data.linkedMessageId !== undefined && { linkedMessageId: data.linkedMessageId }),
        ...(data.linkedSubject   !== undefined && { linkedSubject:   data.linkedSubject }),
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

    await this.resolver.forUser(user).deleteCalendarEvent(buildMailSession(user), event.zimbraId);
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

    // SendInviteReplyRequest requires the invite message ID (invId), not the
    // calendar item ID. Fall back to zimbraId for events created locally.
    const replyId = event.zimbraInviteId ?? event.zimbraId;
    await this.resolver.forUser(user).sendInviteReply(buildMailSession(user), replyId, verb);
    return { success: true };
  }

  // ── Minutes ──────────────────────────────────────────────────────────────

  /**
   * Create the minutes for one event. The caller must own the event row; the
   * occurrence is the row's own `startAt`, because both providers expand a
   * recurring series into one row per instance.
   */
  async createMinutes(userId: string, eventId: string, dto: CreateMinutesDto) {
    const event = await this.prisma.calendarEvent.findFirst({
      where: { id: eventId, userId },
      select: { icalUid: true, startAt: true, attendees: true },
    });
    if (!event) throw new NotFoundException('Event not found');

    return this.docs.createMinutesDocument(userId, {
      title: dto.title,
      content: dto.content,
      attendeeEmails: attendeeEmails(event.attendees),
      icalUid: event.icalUid,
      occurrenceStartAt: event.startAt,
    });
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
    const data = await this.resolver.forUser(user).getFreeBusy(
      buildMailSession(user),
      email,
      start.getTime(),
      end.getTime(),
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
    const provider = this.resolver.forUser(user);
    const session = buildMailSession(user);
    return Promise.all(
      emails.map((email) =>
        provider
          .getFreeBusy(session, email, start.getTime(), end.getTime())
          .then((data) => ({ email, ...data })),
      ),
    );
  }
}
