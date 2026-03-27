import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import { DocsService } from './docs.service';
import { CreateDocDto } from './dto/create-doc.dto';
import { UpdateDocDto } from './dto/update-doc.dto';
import { CreateInviteDto } from './dto/create-invite.dto';
import { UpdateInviteDto } from './dto/update-invite.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { ReactCommentDto } from './dto/react-comment.dto';

@Controller('docs')
export class DocsController {
  constructor(private readonly docsService: DocsService) {}

  // ── Public share routes — declared FIRST to avoid clashing with /:id ────────

  @Get('shared/:token')
  getByToken(@Param('token') token: string) {
    return this.docsService.findByShareToken(token);
  }

  @Patch('shared/:token')
  updateByToken(@Param('token') token: string, @Body() dto: UpdateDocDto) {
    return this.docsService.updateByShareToken(token, dto);
  }

  // ── Authenticated routes ──────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Get()
  findAll(@Req() req: AuthenticatedRequest) {
    return this.docsService.findAll(req.user.sub);
  }

  // Declared before /:id to avoid shadowing
  @UseGuards(JwtAuthGuard)
  @Get('shared-with-me')
  getSharedWithMe(@Req() req: AuthenticatedRequest) {
    return this.docsService.findSharedWithMe(req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateDocDto) {
    return this.docsService.create(req.user.sub, dto);
  }

  // ── Share management — before /:id so ':id/share' doesn't shadow ':id' ────

  @UseGuards(JwtAuthGuard)
  @Post(':id/share')
  enableSharing(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.docsService.enableSharing(req.user.sub, id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/share')
  @HttpCode(HttpStatus.OK)
  disableSharing(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.docsService.disableSharing(req.user.sub, id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/favorite')
  @HttpCode(HttpStatus.OK)
  toggleFavorite(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.docsService.toggleFavorite(req.user.sub, id);
  }

  // ── Invite management — before /:id ──────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Get(':id/invites')
  listInvites(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.docsService.listInvites(req.user.sub, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/invites')
  addInvite(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: CreateInviteDto,
  ) {
    return this.docsService.addInvite(req.user.sub, id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/invites/:inviteId')
  @HttpCode(HttpStatus.OK)
  updateInviteRole(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('inviteId') inviteId: string,
    @Body() dto: UpdateInviteDto,
  ) {
    return this.docsService.updateInviteRole(req.user.sub, id, inviteId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/invites/:inviteId')
  @HttpCode(HttpStatus.OK)
  removeInvite(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('inviteId') inviteId: string,
  ) {
    return this.docsService.removeInvite(req.user.sub, id, inviteId);
  }

  // ── Members (for @mention autocomplete) ──────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Get(':id/members')
  listMembers(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.docsService.listMembers(req.user.sub, id);
  }

  // ── Comments — before /:id so ':id/comments' doesn't shadow ':id' ─────────

  @UseGuards(JwtAuthGuard)
  @Get(':id/comments')
  listComments(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.docsService.listComments(req.user.sub, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/comments')
  createComment(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.docsService.createComment(req.user.sub, id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/comments/:commentId')
  @HttpCode(HttpStatus.OK)
  updateComment(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Body() dto: UpdateCommentDto,
  ) {
    return this.docsService.updateComment(req.user.sub, id, commentId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/comments/:commentId')
  @HttpCode(HttpStatus.OK)
  deleteComment(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
  ) {
    return this.docsService.deleteComment(req.user.sub, id, commentId);
  }

  // ── Reactions ─────────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Post(':id/comments/:commentId/reactions')
  @HttpCode(HttpStatus.OK)
  toggleReaction(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Body() dto: ReactCommentDto,
  ) {
    return this.docsService.toggleReaction(req.user.sub, id, commentId, dto);
  }

  // ── Version history ───────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Get(':id/versions')
  listVersions(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.docsService.listVersions(req.user.sub, id);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/versions/:versionId')
  getVersion(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    return this.docsService.getVersion(req.user.sub, id, versionId);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/versions/:versionId/restore')
  @HttpCode(HttpStatus.OK)
  restoreVersion(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    return this.docsService.restoreVersion(req.user.sub, id, versionId);
  }

  // ── Activity feed ─────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Get(':id/activity')
  listActivity(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.docsService.listActivity(req.user.sub, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/duplicate')
  duplicate(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.docsService.duplicate(req.user.sub, id);
  }

  // ── Doc CRUD ──────────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.docsService.findOne(req.user.sub, id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateDocDto,
  ) {
    return this.docsService.update(req.user.sub, id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.docsService.remove(req.user.sub, id);
  }
}
