import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus,
  Param, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import { ConversationsService } from './conversations.service';
import { AppendTurnsDto, CreateConversationDto } from './dto/conversations.dto';

/**
 * Saved Ask 1Gov conversations. Every route takes the owner from the verified
 * JWT (`req.user.sub`) and never from the path or body, so there is no route
 * on which a caller can name someone else as the owner.
 */
@UseGuards(JwtAuthGuard)
@Controller('ai/conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.conversations.list(req.user.sub, { q, cursor });
  }

  @Get(':id')
  get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.conversations.getTranscript(req.user.sub, id);
  }

  @Post()
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateConversationDto) {
    return this.conversations.create(req.user.sub, {
      scopeKind: dto.scopeKind,
      scopeId: dto.scopeId ?? null,
      scopeLabel: dto.scopeLabel ?? null,
      model: dto.model,
      turnId: dto.turnId ?? null,
      turns: dto.turns,
    });
  }

  @Post(':id/turns')
  @HttpCode(HttpStatus.NO_CONTENT)
  append(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: AppendTurnsDto,
  ) {
    return this.conversations.appendTurns(req.user.sub, id, {
      turns: dto.turns,
      turnId: dto.turnId ?? null,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.conversations.remove(req.user.sub, id);
  }

  @Delete()
  removeAll(@Req() req: AuthenticatedRequest) {
    return this.conversations.removeAll(req.user.sub);
  }
}
