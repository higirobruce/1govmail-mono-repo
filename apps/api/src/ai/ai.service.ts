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
    // Thinking models (qwen3.5, deepseek-r1, …) spend the whole max_tokens
    // budget on hidden reasoning and return an empty `content` — the UI shows
    // a blank response. Ollama's OpenAI layer maps reasoning_effort:"none" to
    // thinking off; a backend that rejects the parameter gets one retry
    // without it so non-thinking setups keep working.
    let res = await this.postChat({ reasoning_effort: 'none', ...body }, signal);
    if (res.status === 400) {
      const text = await res.text().catch(() => '');
      this.logger.warn(
        `Ollama rejected the request with reasoning_effort (400): ${text.slice(0, 200)} — retrying without it`,
      );
      res = await this.postChat({ ...body }, signal);
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

  private async postChat(
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
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
  }

  /**
   * Models actually pulled on the API host. The web app defaults to a model
   * name that may not be installed, which surfaces as an opaque 502 on the
   * first AI action — this lets the UI show what is really available.
   */
  async listModels(signal?: AbortSignal): Promise<{ id: string }[]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/models`, {
        headers: { accept: 'application/json' },
        signal,
      });
    } catch (err) {
      if (signal?.aborted || (err as Error).name === 'AbortError') {
        throw err;
      }
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

    // Shape is OpenAI's `{ data: [{ id, ... }] }`. Anything else means we are
    // not talking to what we think we are — report nothing rather than crash.
    const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
    if (!json || !Array.isArray(json.data)) {
      this.logger.warn(`Unexpected /models payload from ${this.baseUrl}`);
      return [];
    }

    return json.data
      .map((entry) => (entry as { id?: unknown })?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({ id }));
  }
}
