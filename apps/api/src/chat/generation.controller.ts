import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { extractSseText } from '@email-client/shared';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AiService } from '../ai/ai.service';
import { DossierService, type PreparedGeneration } from './dossier.service';
import { MeetingPrepService } from './meeting-prep.service';
import { GenerationCacheService, type CachedGeneration } from './generation-cache.service';
import { DossierRequestDto, MeetingPrepRequestDto } from './dto/generation.dto';

interface AuthenticatedRequest extends Request {
  user: { sub: string };
}

/**
 * Phase 3b one-shot generations: relationship dossier + meeting prep pack.
 * Same SSE protocol as /ai/ask (leading `event: sources`, then OpenAI-shaped
 * deltas). Unlike ask, the finished text is ALSO accumulated server-side and
 * upserted into ai_generations — the GET endpoints serve that cache with a
 * read-time stale flag. Preparation (incl. ownership/own-address checks) runs
 * BEFORE headers flush, so failures are ordinary JSON 4xx.
 */
@UseGuards(JwtAuthGuard)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
@Controller('ai')
export class GenerationController {
  constructor(
    private readonly dossier: DossierService,
    private readonly meetingPrep: MeetingPrepService,
    private readonly cache: GenerationCacheService,
    private readonly aiService: AiService,
  ) {}

  @Post('dossier')
  async streamDossier(
    @Req() req: AuthenticatedRequest, @Res() res: Response, @Body() body: DossierRequestDto,
  ): Promise<void> {
    const prepared = await this.dossier.prepare(req.user.sub, body.email);
    await this.stream(req.user.sub, res, prepared, this.dossier.chatModel);
  }

  @Get('dossier')
  async cachedDossier(
    @Req() req: AuthenticatedRequest, @Query() q: DossierRequestDto,
  ): Promise<{ cached: CachedGeneration | null }> {
    return { cached: await this.cache.get(req.user.sub, 'dossier', q.email.trim().toLowerCase()) };
  }

  @Post('meeting-prep')
  async streamMeetingPrep(
    @Req() req: AuthenticatedRequest, @Res() res: Response, @Body() body: MeetingPrepRequestDto,
  ): Promise<void> {
    const prepared = await this.meetingPrep.prepare(req.user.sub, body.eventId);
    await this.stream(req.user.sub, res, prepared, this.meetingPrep.chatModel);
  }

  @Get('meeting-prep')
  async cachedMeetingPrep(
    @Req() req: AuthenticatedRequest, @Query() q: MeetingPrepRequestDto,
  ): Promise<{ cached: CachedGeneration | null }> {
    return { cached: await this.cache.get(req.user.sub, 'meeting_prep', q.eventId) };
  }

  private async stream(userId: string, res: Response, prepared: PreparedGeneration, model: string): Promise<void> {
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    res.write(`event: sources\ndata: ${JSON.stringify({ sources: prepared.sources, degraded: prepared.degraded })}\n\n`);

    if (!prepared.upstreamBody) {
      // Nothing on file — reply without a model call and WITHOUT caching
      // (a later first-mail should produce a real brief, not serve this).
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: prepared.fallbackReply } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    let upstream: globalThis.Response;
    try {
      upstream = await this.aiService.upstream(prepared.upstreamBody, ac.signal);
    } catch (err: any) {
      if (ac.signal.aborted) { res.end(); return; }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `⚠ ${err?.message ?? 'AI backend error'}` } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (!upstream.body) { res.end(); return; }

    // Pipe bytes to the client verbatim while accumulating the same bytes —
    // the accumulated transcript is parsed once at the end for the cache.
    const decoder = new TextDecoder();
    let transcript = '';
    let completed = false;
    const reader = upstream.body.getReader();
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) { completed = true; break; }
        transcript += decoder.decode(value, { stream: true });
        if (!res.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      }
    } catch (err) {
      if (!ac.signal.aborted) throw err;
    } finally {
      res.end();
    }

    if (completed && !ac.signal.aborted) {
      const content = extractSseText(transcript).trim();
      if (content) {
        await this.cache.upsert(userId, prepared.kind, prepared.targetKey, {
          content, sources: prepared.sources, model, sourceAnchor: prepared.sourceAnchor,
        });
      }
    }
  }
}
