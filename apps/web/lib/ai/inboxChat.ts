/**
 * Client for POST /ai/inbox-chat — like AIClient.chatStream but with one
 * extra protocol element: a leading `event: sources` SSE frame carrying the
 * retrieved sources. Those sources are the ONLY place citation deep-links
 * come from; model text never mints a link (see splitByCitations).
 */
import { authedFetch } from '../authed-fetch';
import { AIHttpError } from './client';

export interface InboxChatSource {
  alias: string;
  messageId: string;
  subject: string | null;
  fromEmail: string;
  fromName: string | null;
  receivedAt: string;
  injectionSuspected: boolean;
  snippet: string;
}

export interface InboxChatDegraded { vector: boolean; keyword: boolean }

export type InboxChatTurn = { role: 'user' | 'assistant'; content: string };

export async function streamInboxChat(
  turns: InboxChatTurn[],
  handlers: {
    onSources: (sources: InboxChatSource[], degraded: InboxChatDegraded) => void;
    onChunk: (delta: string) => void;
    signal?: AbortSignal;
  },
): Promise<string> {
  const res = await authedFetch('/ai/inbox-chat', {
    method: 'POST',
    body: JSON.stringify({ messages: turns.map(({ role, content }) => ({ role, content })) }),
    signal: handlers.signal,
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
          handlers.onSources(parsed?.sources ?? [], parsed?.degraded ?? { vector: false, keyword: false });
          eventName = 'message';
          continue;
        }
        const delta: string = parsed?.choices?.[0]?.delta?.content ?? '';
        if (delta) {
          full += delta;
          handlers.onChunk(delta);
        }
      } catch {
        // keep-alive / non-JSON line — tolerate
      }
    }
  }
  return full;
}
