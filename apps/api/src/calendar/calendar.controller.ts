import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Query,
  Body,
  Param,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { CalendarService } from './calendar.service';
import type { CalendarEventData } from './calendar.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';

@UseGuards(JwtAuthGuard)
@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  /**
   * GET /calendar/events?start=<ISO>&end=<ISO>
   * Returns all calendar events in the given date range.
   */
  @Get('events')
  getEvents(
    @Req() req: AuthenticatedRequest,
    @Query('start') start: string,
    @Query('end') end: string,
  ) {
    const now = new Date();
    const startDate = start ? new Date(start) : new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate   = end   ? new Date(end)   : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    return this.calendarService.getEvents(req.user.sub, startDate, endDate);
  }

  /** POST /calendar/events — create a new calendar event */
  @Post('events')
  @HttpCode(HttpStatus.OK)
  createEvent(
    @Req() req: AuthenticatedRequest,
    @Body() body: CalendarEventData,
  ) {
    return this.calendarService.createEvent(req.user.sub, body);
  }

  /**
   * GET /calendar/events/:id
   * Fetches full event details from Zimbra (complete attendee list with RSVP
   * status). Updates the local DB cache and returns the enriched record.
   */
  @Get('events/:id')
  getEvent(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.calendarService.getEvent(req.user.sub, id);
  }

  /** PATCH /calendar/events/:id — update an existing calendar event */
  @Patch('events/:id')
  @HttpCode(HttpStatus.OK)
  updateEvent(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: CalendarEventData,
  ) {
    return this.calendarService.updateEvent(req.user.sub, id, body);
  }

  /** DELETE /calendar/events/:id — delete a calendar event */
  @Delete('events/:id')
  @HttpCode(HttpStatus.OK)
  deleteEvent(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.calendarService.deleteEvent(req.user.sub, id);
  }

  /** POST /calendar/events/:id/rsvp — accept / decline / tentative a calendar invite */
  @Post('events/:id/rsvp')
  @HttpCode(HttpStatus.OK)
  rsvpEvent(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: { verb: 'ACCEPT' | 'DECLINE' | 'TENTATIVE' },
  ) {
    return this.calendarService.rsvpEvent(req.user.sub, id, body.verb);
  }

  /**
   * GET /calendar/freebusy?email=user@example.com&start=<ISO>&end=<ISO>
   * Returns busy / tentative / unavailable intervals for the given user in the
   * requested time window. Defaults to today if start/end are omitted.
   */
  @Get('freebusy')
  getFreeBusy(
    @Req() req: AuthenticatedRequest,
    @Query('email') email: string,
    @Query('start') start: string,
    @Query('end') end: string,
  ) {
    if (!email?.trim()) throw new BadRequestException('email query param is required');
    const now = new Date();
    const startDate = start ? new Date(start) : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const endDate   = end   ? new Date(end)   : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    return this.calendarService.getFreeBusy(req.user.sub, email.trim(), startDate, endDate);
  }

  /**
   * POST /calendar/freebusy/batch
   * Body: { emails: string[], start: ISO, end: ISO }
   * Returns free/busy data for all supplied emails in parallel.
   */
  @Post('freebusy/batch')
  @HttpCode(HttpStatus.OK)
  getFreeBusyBatch(
    @Req() req: AuthenticatedRequest,
    @Body() body: { emails: string[]; start: string; end: string },
  ) {
    const { emails, start, end } = body;
    if (!Array.isArray(emails) || emails.length === 0) {
      throw new BadRequestException('emails array is required');
    }
    const now = new Date();
    const startDate = start ? new Date(start) : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const endDate   = end   ? new Date(end)   : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    return this.calendarService.getFreeBusyBatch(req.user.sub, emails, startDate, endDate);
  }
}
