/**
 * AI client — calls the server's /ai/chat proxy.
 *
 * The browser never talks to Ollama directly. Instead the NestJS API on the
 * deployment host forwards to a local Ollama (loopback only) using the same
 * OpenAI chat-completions shape. This keeps Ollama unexposed, lets us reuse
 * the JWT for auth, and avoids browser-side CORS / mixed-content issues.
 */

import { authedFetch } from '../authed-fetch';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  /** Cap response length. Most local 7B models are happy with 256–512 tokens. */
  maxTokens?: number;
  signal?: AbortSignal;
}

export class AIClient {
  /** Non-streaming completion — returns the full assistant text. */
  async chat(opts: ChatOptions): Promise<string> {
    const res = await authedFetch('/ai/chat', {
      method: 'POST',
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 512,
        stream: false,
      }),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(await errorText(res));
    const json = await res.json();
    return json?.choices?.[0]?.message?.content ?? '';
  }

  /**
   * Streaming completion — calls onChunk for each delta token, returns
   * the concatenated full text once the stream ends.
   */
  async chatStream(opts: ChatOptions, onChunk: (delta: string) => void): Promise<string> {
    const res = await authedFetch('/ai/chat', {
      method: 'POST',
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 512,
        stream: true,
      }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) throw new Error(await errorText(res));

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return full;
        try {
          const parsed = JSON.parse(payload);
          const delta: string = parsed?.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            full += delta;
            onChunk(delta);
          }
        } catch {
          // Tolerate keep-alive / non-JSON lines.
        }
      }
    }

    return full;
  }
}

async function errorText(res: Response): Promise<string> {
  // The NestJS proxy returns JSON on errors ({ message, statusCode }); fall
  // back to the status text if the body isn't parseable (e.g. on a stream).
  try {
    const json = await res.json();
    return `AI request failed (${res.status}): ${json?.message ?? res.statusText}`;
  } catch {
    return `AI request failed (${res.status} ${res.statusText})`;
  }
}
