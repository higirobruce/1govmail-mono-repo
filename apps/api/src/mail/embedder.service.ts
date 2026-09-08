import { Injectable, Logger } from '@nestjs/common';

/**
 * Batch embedding via Ollama's NATIVE /api/embed endpoint (one HTTP call per
 * message's chunks). OLLAMA_BASE_URL points at the OpenAI-compat root (…/v1)
 * everywhere else in this codebase; the native API lives at the server root,
 * so the /v1 suffix is stripped here.
 */
@Injectable()
export class EmbedderService {
  private readonly logger = new Logger(EmbedderService.name);
  private readonly baseUrl = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1')
    .replace(/\/$/, '')
    .replace(/\/v1$/, '');
  readonly model = process.env.EMBED_MODEL ?? 'bge-m3:latest';
  readonly dims = 1024;

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`Ollama embed ${res.status}`);
    const json = (await res.json().catch(() => null)) as { embeddings?: unknown } | null;
    const embeddings = json?.embeddings;
    if (
      !Array.isArray(embeddings) ||
      embeddings.length !== texts.length ||
      embeddings.some((v) => !Array.isArray(v) || v.length !== this.dims || v.some((n) => typeof n !== 'number'))
    ) {
      throw new Error('Ollama embed: unexpected payload shape');
    }
    return embeddings as number[][];
  }
}
