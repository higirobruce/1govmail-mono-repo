/**
 * Executive-briefing map-reduce pipeline:
 * fetch inbox & sent → hydrate with body/snippet → per-message cards → reduce to summary.
 */

import { extractEmailText } from './extract';
import { UNTRUSTED_CONTENT_RULE, detectInjectionAttempt, fenceUntrusted } from './prompt';
import type { AIClient } from './client';

export type BriefingWindow = 'today' | '24h' | 'week';
export const BRIEFING_MESSAGE_CAP = 50;

export interface BriefingSourceMessage {
  id: string;
  conversationId: string | null;
  direction: 'received' | 'sent';
  fromEmail: string;
  fromName: string | null;
  subject: string | null;
  receivedAt: string;               // ISO
  bodyText?: string | null;
  bodyHtml?: string | null;
  snippet?: string | null;
  attachments: string[];            // "name.pdf (2.1MB)"
}

export function windowStart(window: BriefingWindow, now: Date): Date {
  if (window === '24h') return new Date(now.getTime() - 24 * 3_600_000);
  if (window === 'week') return new Date(now.getTime() - 7 * 24 * 3_600_000);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1_048_576).toFixed(1)}MB`;
}

function toSource(raw: unknown, direction: 'received' | 'sent'): BriefingSourceMessage | null {
  const m = raw as Record<string, any>;
  if (!m || typeof m.id !== 'string' || typeof m.receivedAt !== 'string') return null;
  const attachments = Array.isArray(m.attachments)
    ? m.attachments
        .filter((a: any) => a && typeof a.filename === 'string')
        .map((a: any) => `${a.filename}${formatSize(a.size) ? ` (${formatSize(a.size)})` : ''}`)
    : [];
  return {
    id: m.id,
    conversationId: typeof m.conversationId === 'string' ? m.conversationId : null,
    direction,
    fromEmail: typeof m.fromEmail === 'string' ? m.fromEmail : '',
    fromName: typeof m.fromName === 'string' ? m.fromName : null,
    subject: typeof m.subject === 'string' ? m.subject : null,
    receivedAt: m.receivedAt,
    bodyText: m.bodyText ?? null,
    bodyHtml: m.bodyHtml ?? null,
    snippet: m.snippet ?? null,
    attachments,
  };
}

export function selectWindowMessages(
  inbox: unknown[], sent: unknown[], window: BriefingWindow, now: Date,
  cap: number = BRIEFING_MESSAGE_CAP,
): { selected: BriefingSourceMessage[]; totalInWindow: number } {
  const start = windowStart(window, now).getTime();
  const all = [
    ...inbox.map((m) => toSource(m, 'received')),
    ...sent.map((m) => toSource(m, 'sent')),
  ].filter((m): m is BriefingSourceMessage => m !== null)
   .filter((m) => {
     const t = Date.parse(m.receivedAt);
     return Number.isFinite(t) && t >= start && t <= now.getTime();
   })
   .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  return { selected: all.slice(0, cap), totalInWindow: all.length };
}

export interface BriefingCard {
  messageId: string;
  conversationId: string | null;
  direction: 'received' | 'sent';
  from: string;
  subject: string | null;
  receivedAt: string;
  gist: string;
  asksOfMe: string[];
  deadlines: string[];
  commitmentsIMade: string[];
  waitingOn: string | null;
  importance: 'high' | 'normal' | 'low';
  attachments: string[];
  injectionSuspected: boolean;
}

const CARD_SYSTEM = `${UNTRUSTED_CONTENT_RULE}

You extract facts from one email for an executive's briefing. Output ONLY a JSON object with exactly these keys:
{"gist": string (one sentence, what this email is about),
 "asksOfMe": string[] (explicit requests or decisions directed at the reader; [] if none),
 "deadlines": string[] (dates or times stated in the email; [] if none),
 "commitmentsIMade": string[] (ONLY for emails the reader sent: promises the reader made; [] otherwise),
 "waitingOn": string or null (what the reader is waiting to receive from the sender, if stated),
 "importance": "high" | "normal" | "low"}
Rules: report only what the email actually says — never invent. Empty arrays over guesses. "high" only for decisions, deadlines within days, or senior-official requests. No commentary, no markdown — JSON only.`;

export function buildCardPrompt(msg: BriefingSourceMessage, body: string): { system: string; user: string } {
  const from = msg.fromName ? `${msg.fromName} <${msg.fromEmail}>` : msg.fromEmail;
  const meta = [
    `Direction: ${msg.direction === 'sent' ? 'SENT BY the reader' : 'RECEIVED by the reader'}`,
    `From: ${from}`,
    msg.subject ? `Subject: ${msg.subject}` : null,
    msg.attachments.length ? `Attachments (names only, contents not available): ${msg.attachments.join(', ')}` : null,
  ].filter(Boolean).join('\n');
  return {
    system: CARD_SYSTEM,
    user: `${meta}\n\n${fenceUntrusted('EMAIL', body)}\n\nExtract the JSON card now. Output ONLY the JSON object.`,
  };
}

function firstJsonObject(raw: string): string | null {
  const cleaned = raw.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : null;
}

const strArr = (v: unknown, maxItems = 6, maxLen = 200): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .slice(0, maxItems).map((s) => s.slice(0, maxLen)) : [];

export function parseCardJson(raw: string, msg: BriefingSourceMessage, body: string): BriefingCard | null {
  const jsonText = firstJsonObject(raw ?? '');
  if (!jsonText) return null;
  let data: Record<string, unknown>;
  try { data = JSON.parse(jsonText); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  const importance = data.importance === 'high' || data.importance === 'low' ? data.importance : 'normal';
  return {
    messageId: msg.id,
    conversationId: msg.conversationId,
    direction: msg.direction,
    from: msg.fromName ? `${msg.fromName} <${msg.fromEmail}>` : msg.fromEmail,
    subject: msg.subject,
    receivedAt: msg.receivedAt,
    gist: (typeof data.gist === 'string' ? data.gist : '').slice(0, 300),
    asksOfMe: strArr(data.asksOfMe),
    deadlines: strArr(data.deadlines),
    commitmentsIMade: msg.direction === 'sent' ? strArr(data.commitmentsIMade) : [],
    waitingOn: typeof data.waitingOn === 'string' ? data.waitingOn.slice(0, 200) : null,
    importance,
    attachments: msg.attachments,
    injectionSuspected: detectInjectionAttempt(body),
  };
}

export async function extractCard(
  client: Pick<AIClient, 'chat'>, model: string, msg: BriefingSourceMessage, signal?: AbortSignal,
): Promise<BriefingCard | null> {
  const body = extractEmailText({ bodyText: msg.bodyText, bodyHtml: msg.bodyHtml ?? msg.snippet }, { maxChars: 3000 });
  if (!body) return null;
  const { system, user } = buildCardPrompt(msg, body);
  const messages = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }];
  // Attempt with JSON mode, then once without (backend may reject response_format).
  for (const responseFormat of ['json', undefined] as const) {
    if (signal?.aborted) return null;
    try {
      const raw = await client.chat({ model, messages, temperature: 0, maxTokens: 220, signal, ...(responseFormat ? { responseFormat } : {}) });
      const card = parseCardJson(raw, msg, body);
      if (card) return card;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return null;
      // fall through to the retry
    }
  }
  return null;
}
