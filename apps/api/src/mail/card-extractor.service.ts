import { Injectable, Logger } from '@nestjs/common';
import { buildCardPrompt, parseCardJson, extractEmailText, type CardSource, type ExtractedCard } from '@email-client/shared';

@Injectable()
export class CardExtractorService {
  private readonly logger = new Logger(CardExtractorService.name);
  private readonly baseUrl = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
  readonly model = process.env.CARD_MODEL ?? 'qwen3-4b-fast:latest';

  async extract(msg: CardSource, bodyText: string | null, bodyHtml: string | null): Promise<ExtractedCard | null> {
    const body = extractEmailText({ bodyText, bodyHtml }, { maxChars: 3000 });
    if (!body) return null;
    const { system, user } = buildCardPrompt(msg, body);
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    for (const withJson of [true, false]) {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model, messages, temperature: 0, max_tokens: 300,
          reasoning_effort: 'none',
          ...(withJson ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      if (res.status === 400 && withJson) continue;             // backend rejected json mode — retry bare
      if (!res.ok) throw new Error(`Ollama ${res.status}`);      // network/backend failure — caller retries next tick
      const json = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null;
      const card = parseCardJson(json?.choices?.[0]?.message?.content ?? '', msg, body);
      if (card) return card;
    }
    return null;
  }
}
