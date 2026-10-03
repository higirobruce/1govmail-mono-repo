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
import { AddGroupShareDto } from './dto/group-share.dto';

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
    @Query('groups') groups: string,
  ) {
    return this.contactsService.autocomplete(req.user.sub, q ?? '', {
      includeGroups: groups === 'true',
    });
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

  // ── Contact Groups ─────────────────────────────────────────────────────────

  /** GET /contacts/groups */
  @Get('groups')
  getGroups(@Req() req: AuthenticatedRequest) {
    return this.contactsService.getGroups(req.user.sub);
  }

  /** POST /contacts/groups */
  @Post('groups')
  @HttpCode(HttpStatus.OK)
  createGroup(@Req() req: AuthenticatedRequest, @Body() body: any) {
    return this.contactsService.createGroup(req.user.sub, body);
  }

  /** PATCH /contacts/groups/:id */
  @Patch('groups/:id')
  @HttpCode(HttpStatus.OK)
  updateGroup(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.contactsService.updateGroup(req.user.sub, id, body);
  }

  /** DELETE /contacts/groups/:id */
  @Delete('groups/:id')
  @HttpCode(HttpStatus.OK)
  deleteGroup(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.contactsService.deleteGroup(req.user.sub, id);
  }

  /** GET /contacts/groups/:id/shares — who this group is shared with */
  @Get('groups/:id/shares')
  listShares(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.contactsService.listShares(req.user.sub, id);
  }

  /** POST /contacts/groups/:id/shares — invite someone (owner only) */
  @Post('groups/:id/shares')
  @HttpCode(HttpStatus.OK)
  addShare(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: AddGroupShareDto,
  ) {
    return this.contactsService.addShare(req.user.sub, id, body);
  }

  /** DELETE /contacts/groups/:id/shares/:inviteId — revoke (owner only) */
  @Delete('groups/:id/shares/:inviteId')
  @HttpCode(HttpStatus.OK)
  removeShare(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('inviteId') inviteId: string,
  ) {
    return this.contactsService.removeShare(req.user.sub, id, inviteId);
  }
}
