import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AiService } from './ai.service';
import { ChatRequestDto } from './dto/chat.dto';

/**
 * Thin proxy in front of Ollama. Two paths:
 *  - stream:false → await full JSON, return as application/json
 *  - stream:true  → pipe Ollama's SSE bytes straight to the client
 *
 * AI calls can be expensive (many tokens, model warmup). Stricter throttle
 * than the global default to keep one user from hogging the GPU/CPU.
 */
@UseGuards(JwtAuthGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Get('models')
  async models(): Promise<{ models: { id: string }[] }> {
    return { models: await this.aiService.listModels() };
  }

  @Post('chat')
  async chat(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: ChatRequestDto,
  ): Promise<void> {
    // Abort the upstream fetch if the browser disconnects (user cancelled,
    // navigated away, network dropped). Without this the model keeps
    // generating tokens nobody will read. Listen on the response, not the
    // request: req 'close' fires once the body is consumed, not on disconnect.
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });

    const upstream = await this.aiService.upstream(body, ac.signal);

    if (!body.stream) {
      const json = await upstream.json();
      res.status(200).json(json);
      return;
    }

    // SSE passthrough. Ollama already emits OpenAI-style `data: {...}\n\n`
    // chunks terminated by `data: [DONE]`, so we just relay bytes.
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Disable buffering on nginx so tokens flush immediately to the client.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

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
        // value is a Uint8Array; express's res.write accepts it directly.
        if (!res.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      }
    } catch (err) {
      // reader.read() throws on abort; the client already disconnected, so
      // there is nobody to report the error to. Rethrow anything else.
      if (!ac.signal.aborted) throw err;
    } finally {
      res.end();
    }
  }
}
