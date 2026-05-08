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

// ── Rewrite ───────────────────────────────────────────────────────────────

export type RewriteMode = 'paraphrase' | 'formal' | 'concise' | 'friendly' | 'grammar';

const REWRITE_PROMPTS: Record<RewriteMode, string> = {
  paraphrase: `Rewrite the user's text in different words while preserving the exact meaning. Match the original tone, register, and approximate length. Output ONLY the rewritten text — no preamble, no quotes, no explanation, no "Here is…" or "Sure!".`,

  formal: `Rewrite the user's text in a more formal, professional register suitable for government or business correspondence. Preserve the meaning. Keep approximately the same length. Output ONLY the rewritten text — no preamble, no quotes, no explanation.`,

  concise: `Rewrite the user's text more concisely. Remove filler words, redundancies, and softeners. Preserve all factual content, names, dates, numbers, and requests. Aim for roughly 60–70% of the original length. Output ONLY the rewritten text — no preamble, no quotes, no explanation.`,

  friendly: `Rewrite the user's text in a warmer, friendlier tone — natural, conversational, but still professional. Preserve the meaning and any factual content. Keep approximately the same length. Output ONLY the rewritten text — no preamble, no quotes, no explanation.`,

  grammar: `Fix grammar, spelling, and punctuation in the user's text. Do NOT change the meaning, tone, register, or wording beyond what is needed for correctness. If the text is already correct, output it unchanged. Output ONLY the corrected text — no preamble, no quotes, no explanation, no list of fixes.`,
};

const REWRITE_CONTEXT_RULE = `

The user's message may include a <context> block describing an email the user is replying to or forwarding. Use the context ONLY to inform tone, register, and naming choices in your rewrite — match the formality of the other party. Do NOT echo any part of the context in your output. Rewrite ONLY the text inside the <text> block.`;

export interface RewriteOptions {
  model: string;
  /** Optional context (e.g. the message being replied to). Helps the model match tone. */
  context?: string;
  signal?: AbortSignal;
}

export async function rewriteText(
  client: AIClient,
  text: string,
  mode: RewriteMode,
  opts: RewriteOptions,
  onChunk: (delta: string) => void,
): Promise<string> {
  const plain = htmlToPlainText(text).trim();
  if (!plain) return '';

  const ctx = opts.context?.trim();
  const system = ctx ? REWRITE_PROMPTS[mode] + REWRITE_CONTEXT_RULE : REWRITE_PROMPTS[mode];
  const userPayload = ctx
    ? `<context>\n${truncate(ctx, 1500)}\n</context>\n\n<text>\n${plain}\n</text>`
    : plain;

  // Roughly proportional to input — local 7B models max out around 600 tokens.
  const approxTokens = Math.min(600, Math.max(96, Math.ceil(plain.length / 3)));

  return client.chatStream(
    {
      model: opts.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPayload },
      ],
      temperature: mode === 'grammar' ? 0.1 : 0.4,
      maxTokens: approxTokens,
      signal: opts.signal,
    },
    onChunk,
  );
}
