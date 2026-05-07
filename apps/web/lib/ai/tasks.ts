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

const SUMMARIZE_MESSAGE_SYSTEM = `You write tight summaries of a single email for a busy reader who must act. 2–3 sentences, plain prose, no preamble, no meta-commentary.

Capture only the substance:
- The bottom line — what is being asked, decided, or communicated.
- Concrete action items or deadlines for the recipient, if any.
- Open questions or missing information, if any.

Do NOT narrate. Do NOT begin with phrases like "The sender writes…", "The email asks…", "This message is about…". Skip greetings, sign-offs, signatures, and any text quoted from earlier replies. The reader trusts you to leave out filler.`;

const SUMMARIZE_THREAD_SYSTEM = `You write tight summaries of email threads for a reader who has not been following them. 3–4 sentences, plain prose, no preamble, no meta-commentary.

Report only where the thread stands NOW:
- What has been decided or agreed.
- What is still open: pending decisions, unanswered questions, missing approvals.
- What the recipient is expected to do, with deadlines if stated.

Treat superseded points as resolved — only the most recent position on each topic matters. Do NOT recap the thread message by message. Do NOT say things like "the thread discusses…", "they then replied…", or list participants by name. Skip greetings, sign-offs, and quoted history. The reader trusts you to synthesize, not narrate.`;

export interface SummarizeOptions {
  model: string;
  /** Subject line, included in the user prompt for context. */
  subject?: string;
  /** Sender display name + email, included for context. */
  from?: string;
  /** Aborts the underlying fetch. */
  signal?: AbortSignal;
}

async function runSummarize(
  client: AIClient,
  systemPrompt: string,
  body: string,
  opts: SummarizeOptions,
  onChunk: (delta: string) => void,
): Promise<string> {
  const plain = truncate(htmlToPlainText(body));
  const header = [
    opts.subject ? `Subject: ${opts.subject}` : null,
    opts.from ? `Context: ${opts.from}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const userPrompt = header ? `${header}\n\n---\n\n${plain}` : plain;

  return client.chatStream(
    {
      model: opts.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      maxTokens: 320,
      signal: opts.signal,
    },
    onChunk,
  );
}

/** Summarize a single email body. */
export async function summarizeMessage(
  client: AIClient,
  body: string,
  opts: SummarizeOptions,
  onChunk: (delta: string) => void,
): Promise<string> {
  return runSummarize(client, SUMMARIZE_MESSAGE_SYSTEM, body, opts, onChunk);
}

/** Summarize a multi-message thread (the body should be the concatenated messages with separators). */
export async function summarizeThread(
  client: AIClient,
  body: string,
  opts: SummarizeOptions,
  onChunk: (delta: string) => void,
): Promise<string> {
  return runSummarize(client, SUMMARIZE_THREAD_SYSTEM, body, opts, onChunk);
}
