/**
 * Thin OpenAI-compatible chat-completions client.
 *
 * Talks `POST {baseUrl}/chat/completions` with the OpenAI JSON shape — the
 * lingua franca of Ollama, LM Studio, llama.cpp server, vLLM, LocalAI,
 * OpenRouter, OpenAI itself, and most provider proxies. Switching between
 * local and remote inference is just a different baseUrl + (optional) apiKey.
 */

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

export interface AIClientConfig {
  baseUrl: string;
  apiKey?: string;
}

export class AIClient {
  constructor(private readonly config: AIClientConfig) {}

  /** Non-streaming completion — returns the full assistant text. */
  async chat(opts: ChatOptions): Promise<string> {
    const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 512,
        stream: false,
      }),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`AI request failed (${res.status} ${res.statusText})`);
    const json = await res.json();
    return json?.choices?.[0]?.message?.content ?? '';
  }

  /**
   * Streaming completion — calls onChunk for each delta token, returns
   * the concatenated full text once the stream ends.
   */
  async chatStream(opts: ChatOptions, onChunk: (delta: string) => void): Promise<string> {
    const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 512,
        stream: true,
      }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`AI request failed (${res.status} ${res.statusText})`);
    }

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

  private headers(): HeadersInit {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) h['authorization'] = `Bearer ${this.config.apiKey}`;
    return h;
  }
}
