/**
 * Client for POST /ai/ask — Ask 1Gov: chat grounded in the user's own mail,
 * docs, and calendar. Protocol: a leading `event: sources` SSE frame carrying
 * the retrieved sources, then normal OpenAI-shaped delta chunks. Those
 * sources are the ONLY place citation deep-links come from; model text never
 * mints a link (see splitByCitations).
 */
import { authedFetch } from '../authed-fetch';
import { AIHttpError } from './client';

export type AskSourceType = 'mail' | 'doc' | 'event';

export interface AskSource {
  alias: string;
  type: AskSourceType;
  id: string;
  title: string | null;
  fromEmail?: string; // mail only
  fromName?: string | null; // mail only
  date: string; // ISO
  meta?: string | null; // event when/where line, doc emoji
  injectionSuspected: boolean;
  snippet: string;
}

export interface AskDegraded { vector: boolean; keyword: boolean; docs: boolean; calendar: boolean }

export type AskTurn = { role: 'user' | 'assistant'; content: string };

export async function streamAsk(
  turns: AskTurn[],
  opts: {
    scope?: { docId: string } | null;
    onSources: (sources: AskSource[], degraded: AskDegraded) => void;
    onChunk: (delta: string) => void;
    signal?: AbortSignal;
  },
): Promise<string> {
  const res = await authedFetch('/ai/ask', {
    method: 'POST',
    body: JSON.stringify({
      messages: turns.map(({ role, content }) => ({ role, content })),
      ...(opts.scope ? { scope: { docId: opts.scope.docId } } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    let message = `AI request failed (${res.status})`;
    try {
      const json = await res.json();
      message = `AI request failed (${res.status}): ${json?.message ?? res.statusText}`;
    } catch { /* stream body — keep default */ }
    throw new AIHttpError(message, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let eventName = 'message';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return full;
      try {
        const parsed = JSON.parse(payload);
        if (eventName === 'sources') {
          opts.onSources(
            parsed?.sources ?? [],
            parsed?.degraded ?? { vector: false, keyword: false, docs: false, calendar: false },
          );
          eventName = 'message';
          continue;
        }
        const delta: string = parsed?.choices?.[0]?.delta?.content ?? '';
        if (delta) {
          full += delta;
          opts.onChunk(delta);
        }
      } catch {
        // keep-alive / non-JSON line — tolerate
      }
    }
  }
  return full;
}
