/**
 * Shared SSE reader for the AI streaming endpoints (/ai/ask, /ai/dossier,
 * /ai/meeting-prep). Protocol: an optional leading `event: sources` frame
 * carrying retrieved sources, then normal OpenAI-shaped delta chunks, then a
 * `data: [DONE]` sentinel. Extracted from ask.ts's streamAsk loop verbatim —
 * behavior-preserving, see ask.test.ts.
 */
export async function readSse(
  res: Response,
  opts: {
    onSources?: (sources: any[], degraded: any) => void;
    onChunk: (delta: string) => void;
  },
): Promise<string> {
  const reader = res.body!.getReader();
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
          opts.onSources?.(
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

/** Like readSse, but dispatches ALL named events to onEvent (agent protocol). */
export async function readEventSse(
  res: Response,
  opts: { onChunk: (delta: string) => void; onEvent?: (name: string, data: any) => void },
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let full = '';

  const handleLine = (line: string) => {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      return;
    }
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return 'done';
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (eventName !== 'message') {
      opts.onEvent?.(eventName, parsed);
      eventName = 'message';
      return;
    }
    const delta = parsed?.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta) {
      full += delta;
      opts.onChunk(delta);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const result = handleLine(buffer.slice(0, nl).trimEnd());
      buffer = buffer.slice(nl + 1);
      if (result === 'done') return full;
    }
  }
  return full;
}
