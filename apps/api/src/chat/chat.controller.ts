import { BadRequestException, Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AiService } from '../ai/ai.service';
import { InboxChatService } from './inbox-chat.service';
import { InboxChatRequestDto } from './dto/inbox-chat.dto';

interface AuthenticatedRequest extends Request {
  user: { sub: string };
}

/**
 * Ask-your-inbox chat. Stricter throttle than the general AI proxy: each call
 * fans out retrieval (pgvector + Zimbra) plus a 30B generation.
 *
 * READ-ONLY by design: no write action of any kind — see the phase-4 spec's
 * threat model. The client never supplies the system prompt (DTO restricts
 * roles) and only ever receives source references it can resolve against the
 * `sources` event this controller emits first.
 */
@UseGuards(JwtAuthGuard)
@Throttle({ default: { limit: 20, ttl: 60_000 } })
@Controller('ai')
export class ChatController {
  constructor(
    private readonly inboxChatService: InboxChatService,
    private readonly aiService: AiService,
  ) {}

  @Post('inbox-chat')
  async inboxChat(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Body() body: InboxChatRequestDto,
  ): Promise<void> {
    const last = body.messages[body.messages.length - 1];
    if (last.role !== 'user') {
      throw new BadRequestException('last turn must be from the user');
    }

    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });

    // Retrieval + prompt assembly BEFORE headers: a thrown error here still
    // becomes a normal JSON error response the web client knows how to show.
    const prepared = await this.inboxChatService.prepare(req.user.sub, body.messages);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    res.write(
      `event: sources\ndata: ${JSON.stringify({ sources: prepared.sources, degraded: prepared.degraded })}\n\n`,
    );

    if (!prepared.upstreamBody) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: prepared.noSourcesReply } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    let upstream: globalThis.Response;
    try {
      upstream = await this.aiService.upstream(prepared.upstreamBody, ac.signal);
    } catch (err: any) {
      if (ac.signal.aborted) {
        // Client disconnected — nothing to deliver, don't write an error delta.
        res.end();
        return;
      }
      // Headers are already out — deliver the failure as a readable delta.
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `⚠ ${err?.message ?? 'AI backend error'}` } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (!upstream.body) {
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      }
    } catch (err) {
      if (!ac.signal.aborted) throw err;
    } finally {
      res.end();
    }
  }
}
