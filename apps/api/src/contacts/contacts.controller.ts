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
} from '@nestjs/common';
import { ContactsService } from './contacts.service';
import type { ContactData } from './contacts.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';

@UseGuards(JwtAuthGuard)
@Controller('contacts')
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  /**
   * GET /contacts/autocomplete?q=<prefix>
   * Used by the compose form's email chip input.
   */
  @Get('autocomplete')
  autocomplete(
    @Req() req: AuthenticatedRequest,
    @Query('q') q: string,
  ): Promise<Array<{ email: string; display: string }>> {
    return this.contactsService.autocomplete(req.user.sub, q ?? '');
  }

  /**
   * GET /contacts?q=<search>&sync=true
   * Returns all contacts for the user, optionally filtered by query.
   * Pass `sync=true` to force a fresh pull from Zimbra before returning.
   */
  @Get()
  getContacts(
    @Req() req: AuthenticatedRequest,
    @Query('q') q: string,
    @Query('sync') sync: string,
  ) {
    return this.contactsService.getContacts(req.user.sub, q, sync === 'true');
  }

  /** POST /contacts — create a new contact */
  @Post()
  @HttpCode(HttpStatus.OK)
  createContact(
    @Req() req: AuthenticatedRequest,
    @Body() body: ContactData,
  ) {
    return this.contactsService.createContact(req.user.sub, body);
  }

  /** PATCH /contacts/:id — update an existing contact */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  updateContact(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: ContactData,
  ) {
    return this.contactsService.updateContact(req.user.sub, id, body);
  }

  /** DELETE /contacts/:id — delete a contact */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  deleteContact(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.contactsService.deleteContact(req.user.sub, id);
  }
}
