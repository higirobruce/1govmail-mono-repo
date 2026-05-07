import { AIClient } from './client';

/**
 * Strip HTML tags + collapse whitespace. Email bodies often arrive as HTML
 * with quoted threads; we feed the model plain text so we don't burn tokens
 * on `<br/>` and inline styles.
 */
export function htmlToPlainText(html: string): string {
  if (typeof document === 'undefined') return html;
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent ?? div.innerText ?? '').replace(/\s+/g, ' ').trim();
}

/** Trim to a character cap with a clear ellipsis marker. ~3000 chars ≈ 700–900 tokens. */
export function truncate(text: string, maxChars = 3000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n\n[…truncated]';
}

const SUMMARIZE_SYSTEM = `You are a concise email summarizer for a government office. Summarize the email in 2–4 short sentences, focusing on:
1. What the sender is asking or telling the recipient.
2. Any deadlines, action items, or decisions required.
3. Any next steps or unanswered questions.
Use plain prose, no bullet points, no preamble.`;

export interface SummarizeOptions {
  model: string;
  /** Subject line, included in the user prompt for context. */
  subject?: string;
  /** Sender display name + email, included for context. */
  from?: string;
  /** Aborts the underlying fetch. */
  signal?: AbortSignal;
}

export async function summarizeMessage(
  client: AIClient,
  body: string,
  opts: SummarizeOptions,
  onChunk: (delta: string) => void,
): Promise<string> {
  const plain = truncate(htmlToPlainText(body));
  const header = [
    opts.subject ? `Subject: ${opts.subject}` : null,
    opts.from ? `From: ${opts.from}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const userPrompt = header ? `${header}\n\n---\n\n${plain}` : plain;

  return client.chatStream(
    {
      model: opts.model,
      messages: [
        { role: 'system', content: SUMMARIZE_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      maxTokens: 256,
      signal: opts.signal,
    },
    onChunk,
  );
}
