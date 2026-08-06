import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ChatRequestDto } from './dto/chat.dto';

/**
 * Forwards chat-completion calls to a local Ollama (or any OpenAI-compatible)
 * server reachable from the API host. The browser never contacts Ollama
 * directly — it goes through the JWT-guarded /ai/chat endpoint, so the
 * Ollama port stays bound to loopback on the deployment server.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  /** Default points at a local Ollama on the API host (`/v1` is OpenAI-compat root). */
  private readonly baseUrl =
    (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1').replace(/\/$/, '');

  /** Single fetch call used by both streaming and non-streaming paths. */
  async upstream(body: ChatRequestDto, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      // Client cancelled — not a backend failure, don't report it as one.
      if (signal.aborted || (err as Error).name === 'AbortError') {
        throw err;
      }
      // Network-level failure (Ollama not running, host unreachable, etc.).
      this.logger.error(`Ollama unreachable at ${this.baseUrl}: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        'AI backend unreachable. Make sure Ollama is running on the API host.',
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.warn(`Ollama returned ${res.status}: ${text.slice(0, 200)}`);
      throw new BadGatewayException(
        `AI backend error (${res.status}): ${text.slice(0, 200) || res.statusText}`,
      );
    }

    return res;
  }
}
