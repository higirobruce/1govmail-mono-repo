import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { MailService } from './mail.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SendMessageDto } from './dto/send-message.dto';
import { SaveDraftDto } from './dto/save-draft.dto';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';

@UseGuards(JwtAuthGuard)
@Controller('mail')
export class MailController {
  constructor(private readonly mailService: MailService) {}

  @Get('folders')
  getFolders(@Req() req: AuthenticatedRequest) {
    return this.mailService.getFolders(req.user.sub);
  }

  @Get('folders/:folderId/messages')
  getMessages(
    @Req() req: AuthenticatedRequest,
    @Param('folderId') folderId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.mailService.getMessages(req.user.sub, folderId, limit, offset);
  }

  @Get('search')
  searchMessages(
    @Req() req: AuthenticatedRequest,
    @Query('q') q: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.mailService.searchMessages(req.user.sub, q ?? '', limit, offset);
  }

  @Get('messages/:messageId')
  getMessage(
    @Req() req: AuthenticatedRequest,
    @Param('messageId') messageId: string,
  ) {
    return this.mailService.getMessage(req.user.sub, messageId);
  }

  @Post('send')
  @HttpCode(HttpStatus.OK)
  sendMessage(@Req() req: AuthenticatedRequest, @Body() dto: SendMessageDto) {
    return this.mailService.sendMessage(req.user.sub, dto);
  }

  @Delete('messages/:messageId')
  @HttpCode(HttpStatus.OK)
  deleteMessage(
    @Req() req: AuthenticatedRequest,
    @Param('messageId') messageId: string,
  ) {
    return this.mailService.deleteMessage(req.user.sub, messageId);
  }

  @Patch('messages/:messageId/read')
  @HttpCode(HttpStatus.OK)
  markRead(
    @Req() req: AuthenticatedRequest,
    @Param('messageId') messageId: string,
    @Body('read') read: boolean,
  ) {
    return this.mailService.markRead(req.user.sub, messageId, read);
  }

  @Patch('messages/:messageId/move')
  @HttpCode(HttpStatus.OK)
  moveMessage(
    @Req() req: AuthenticatedRequest,
    @Param('messageId') messageId: string,
    @Body('folderId') folderId: string,
  ) {
    return this.mailService.moveMessage(req.user.sub, messageId, folderId);
  }

  @Post('folders')
  @HttpCode(HttpStatus.OK)
  createFolder(
    @Req() req: AuthenticatedRequest,
    @Body('name') name: string,
  ) {
    return this.mailService.createFolder(req.user.sub, name);
  }

  // ── Drafts ───────────────────────────────────────────────────────────────────

  @Post('drafts')
  @HttpCode(HttpStatus.OK)
  saveDraft(@Req() req: AuthenticatedRequest, @Body() dto: SaveDraftDto) {
    return this.mailService.saveDraft(req.user.sub, dto);
  }

  @Delete('drafts/:zimbraId')
  @HttpCode(HttpStatus.OK)
  discardDraft(
    @Req() req: AuthenticatedRequest,
    @Param('zimbraId') zimbraId: string,
  ) {
    return this.mailService.discardDraft(req.user.sub, zimbraId);
  }

  @Delete('folders/:folderId')
  @HttpCode(HttpStatus.OK)
  deleteFolder(
    @Req() req: AuthenticatedRequest,
    @Param('folderId') folderId: string,
  ) {
    return this.mailService.deleteFolder(req.user.sub, folderId);
  }

  /**
   * Stream an attachment from Zimbra back to the client.
   * :part is the Zimbra MIME part number (e.g. "2" or "2.1").
   */
  @Get('messages/:messageId/attachments/:part')
  async downloadAttachment(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param('messageId') messageId: string,
    @Param('part') part: string,
  ) {
    const { stream, contentType, filename } =
      await this.mailService.downloadAttachment(req.user.sub, messageId, part);

    const safeName = encodeURIComponent(filename).replace(/%20/g, ' ');
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Cache-Control': 'private, max-age=3600',
    });
    stream.pipe(res);
  }
}
