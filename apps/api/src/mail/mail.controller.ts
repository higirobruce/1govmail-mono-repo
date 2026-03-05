import {
  Controller,
  Get,
  Post,
  Put,
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
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { MailService } from './mail.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SendMessageDto } from './dto/send-message.dto';
import { SaveDraftDto } from './dto/save-draft.dto';
import { SnoozeMessageDto } from './dto/snooze-message.dto';
import { ScheduleMessageDto } from './dto/schedule-message.dto';
import { CreateTemplateDto } from './dto/create-template.dto';
import { CreateRuleDto } from './dto/create-rule.dto';
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

  @Get('messages/:messageId/conversation')
  getConversation(
    @Req() req: AuthenticatedRequest,
    @Param('messageId') messageId: string,
  ) {
    return this.mailService.getConversation(req.user.sub, messageId);
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

  /** Send a message with file attachments (multipart/form-data).
   *  The JSON payload fields are carried as a single `payload` form field. */
  @Post('send-with-attachments')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FilesInterceptor('attachments', 10))
  sendMessageWithAttachments(
    @Req() req: AuthenticatedRequest,
    @Body('payload') payloadJson: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    const dto: SendMessageDto = JSON.parse(payloadJson);
    return this.mailService.sendMessage(req.user.sub, dto, files ?? []);
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

  @Post('folders/:folderId/empty')
  @HttpCode(HttpStatus.OK)
  emptyFolder(
    @Req() req: AuthenticatedRequest,
    @Param('folderId') folderId: string,
  ) {
    return this.mailService.emptyFolder(req.user.sub, folderId);
  }

  @Patch('folders/:folderId')
  @HttpCode(HttpStatus.OK)
  renameFolder(
    @Req() req: AuthenticatedRequest,
    @Param('folderId') folderId: string,
    @Body('name') name: string,
  ) {
    return this.mailService.renameFolder(req.user.sub, folderId, name);
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

  // ── Snooze ───────────────────────────────────────────────────────────────────

  @Post('snooze')
  @HttpCode(HttpStatus.OK)
  snoozeMessage(@Req() req: AuthenticatedRequest, @Body() dto: SnoozeMessageDto) {
    return this.mailService.snoozeMessage(req.user.sub, dto.messageId, dto.snoozedUntil, dto.originalFolderId);
  }

  @Delete('snooze/:messageId')
  @HttpCode(HttpStatus.OK)
  unsnoozeMessage(@Req() req: AuthenticatedRequest, @Param('messageId') messageId: string) {
    return this.mailService.unsnoozeMessage(req.user.sub, messageId);
  }

  @Get('snoozed')
  getSnoozed(@Req() req: AuthenticatedRequest) {
    return this.mailService.getSnoozed(req.user.sub);
  }

  // ── Scheduled Send ───────────────────────────────────────────────────────────

  @Post('scheduled')
  @HttpCode(HttpStatus.OK)
  scheduleMessage(@Req() req: AuthenticatedRequest, @Body() dto: ScheduleMessageDto) {
    return this.mailService.scheduleMessage(req.user.sub, dto);
  }

  @Delete('scheduled/:id')
  @HttpCode(HttpStatus.OK)
  cancelScheduledMessage(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.mailService.cancelScheduledMessage(req.user.sub, id);
  }

  @Get('scheduled')
  getScheduledMessages(@Req() req: AuthenticatedRequest) {
    return this.mailService.getScheduledMessages(req.user.sub);
  }

  // ── Templates ────────────────────────────────────────────────────────────────

  @Get('templates')
  getTemplates(@Req() req: AuthenticatedRequest) {
    return this.mailService.getTemplates(req.user.sub);
  }

  @Post('templates')
  @HttpCode(HttpStatus.OK)
  createTemplate(@Req() req: AuthenticatedRequest, @Body() dto: CreateTemplateDto) {
    return this.mailService.createTemplate(req.user.sub, dto);
  }

  @Put('templates/:id')
  @HttpCode(HttpStatus.OK)
  updateTemplate(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: Partial<CreateTemplateDto>) {
    return this.mailService.updateTemplate(req.user.sub, id, dto);
  }

  @Delete('templates/:id')
  @HttpCode(HttpStatus.OK)
  deleteTemplate(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.mailService.deleteTemplate(req.user.sub, id);
  }

  // ── Rules ────────────────────────────────────────────────────────────────────

  @Get('rules')
  getRules(@Req() req: AuthenticatedRequest) {
    return this.mailService.getRules(req.user.sub);
  }

  @Post('rules')
  @HttpCode(HttpStatus.OK)
  createRule(@Req() req: AuthenticatedRequest, @Body() dto: CreateRuleDto) {
    return this.mailService.createRule(req.user.sub, dto);
  }

  @Put('rules/:id')
  @HttpCode(HttpStatus.OK)
  updateRule(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: Partial<CreateRuleDto>) {
    return this.mailService.updateRule(req.user.sub, id, dto);
  }

  @Delete('rules/:id')
  @HttpCode(HttpStatus.OK)
  deleteRule(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.mailService.deleteRule(req.user.sub, id);
  }

  // ── Mute ─────────────────────────────────────────────────────────────────────

  @Post('mute/:conversationId')
  @HttpCode(HttpStatus.OK)
  muteConversation(@Req() req: AuthenticatedRequest, @Param('conversationId') conversationId: string) {
    return this.mailService.muteConversation(req.user.sub, conversationId);
  }

  @Delete('mute/:conversationId')
  @HttpCode(HttpStatus.OK)
  unmuteConversation(@Req() req: AuthenticatedRequest, @Param('conversationId') conversationId: string) {
    return this.mailService.unmuteConversation(req.user.sub, conversationId);
  }

  @Get('muted')
  getMutedConversations(@Req() req: AuthenticatedRequest) {
    return this.mailService.getMutedConversations(req.user.sub);
  }

  // ── Bulk ─────────────────────────────────────────────────────────────────────

  @Post('bulk/mark-read')
  @HttpCode(HttpStatus.OK)
  bulkMarkRead(
    @Req() req: AuthenticatedRequest,
    @Body('messageIds') messageIds: string[],
    @Body('read') read: boolean,
  ) {
    return this.mailService.bulkMarkRead(req.user.sub, messageIds, read);
  }

  @Post('bulk/delete')
  @HttpCode(HttpStatus.OK)
  bulkDelete(@Req() req: AuthenticatedRequest, @Body('messageIds') messageIds: string[]) {
    return this.mailService.bulkDelete(req.user.sub, messageIds);
  }

  @Post('bulk/move')
  @HttpCode(HttpStatus.OK)
  bulkMove(
    @Req() req: AuthenticatedRequest,
    @Body('messageIds') messageIds: string[],
    @Body('folderId') folderId: string,
  ) {
    return this.mailService.bulkMove(req.user.sub, messageIds, folderId);
  }
}
