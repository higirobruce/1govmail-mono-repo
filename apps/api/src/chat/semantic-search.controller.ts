import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RetrievalService } from './retrieval.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string };
}

/**
 * Semantic mode of mail search — the vector leg alone, in the same response
 * shape as GET /mail/search so list UIs reuse their rendering unchanged.
 * Lives in the chat module (it owns retrieval); the literal path cannot
 * collide with mail.controller's `search` route.
 */
@UseGuards(JwtAuthGuard)
@Controller('mail/search')
export class SemanticSearchController {
  constructor(private readonly retrieval: RetrievalService) {}

  @Get('semantic')
  async semantic(
    @Req() req: AuthenticatedRequest,
    @Query('q') q?: string,
    @Query('limit') limitParam?: string,
  ) {
    const query = (q ?? '').trim();
    if (query.length < 2) throw new BadRequestException('q must be at least 2 characters');
    const limit = Math.min(Math.max(Number(limitParam) || 10, 1), 20);
    const messages = await this.retrieval.semantic(req.user.sub, query, limit);
    return { messages, total: messages.length, offset: 0, limit, hasMore: false };
  }
}
