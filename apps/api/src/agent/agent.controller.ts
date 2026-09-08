import { BadRequestException, Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AgentService, type EmitFn } from './agent.service';
import { AgentRequestDto } from './dto/agent.dto';

interface AuthenticatedRequest extends Request {
  user: { sub: string };
}

/**
 * Phase 4 agent endpoint. The loop itself performs no outward or
 * irreversible write — gated actions surface as `proposal` frames the
 * client executes through existing REST endpoints after user approval.
 * See docs/superpowers/specs/2026-09-06-agentic-tools-design.md.
 */
@UseGuards(JwtAuthGuard)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
@Controller('ai')
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Post('agent')
  async agent(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Body() body: AgentRequestDto,
  ): Promise<void> {
    const last = body.messages[body.messages.length - 1];
    if (last.role !== 'user') {
      throw new BadRequestException('last turn must be from the user');
    }

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

    const emit: EmitFn = (event, data) => {
      if (res.writableEnded) return;
      const payload = JSON.stringify(data);
      res.write(event ? `event: ${event}\ndata: ${payload}\n\n` : `data: ${payload}\n\n`);
    };

    try {
      await this.agentService.run(
        req.user.sub,
        body.messages.map((m) => ({ role: m.role, content: m.content })),
        emit,
        ac.signal,
      );
    } catch (err: any) {
      if (!ac.signal.aborted) {
        emit(null, { choices: [{ delta: { content: `⚠ ${err?.message ?? 'Agent error'}` } }] });
      }
    } finally {
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  }
}
