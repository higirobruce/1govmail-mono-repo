import {
  Controller,
  Get,
  Post,
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

  /** DELETE /calendar/events/:id — delete a calendar event */
  @Delete('events/:id')
  @HttpCode(HttpStatus.OK)
  deleteEvent(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.calendarService.deleteEvent(req.user.sub, id);
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
}
