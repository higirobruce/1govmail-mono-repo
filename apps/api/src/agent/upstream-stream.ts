export interface UpstreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AgentStreamResult {
  text: string;
  toolCalls: UpstreamToolCall[];
  finishReason: string | null;
}

/**
 * Reads an OpenAI-compat SSE stream, forwarding content deltas and
 * assembling fragmented tool_calls (deltas arrive keyed by index with
 * function.arguments split across chunks).
 */
export async function consumeAgentStream(
  upstream: globalThis.Response,
  onTextDelta: (delta: string) => void,
): Promise<AgentStreamResult> {
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let finishReason: string | null = null;
  const calls = new Map<number, UpstreamToolCall>();

  const handleLine = (line: string) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const choice = parsed?.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      onTextDelta(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const existing = calls.get(idx) ?? { id: '', name: '', arguments: '' };
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.name = tc.function.name;
      if (tc.function?.arguments) existing.arguments += tc.function.arguments;
      calls.set(idx, existing);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      handleLine(buf.slice(0, nl).trimEnd());
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) handleLine(buf.trim());

  return { text, toolCalls: [...calls.values()].filter((c) => c.name), finishReason };
}

/**
 * Reads a NON-streamed OpenAI-compat completion into the same result shape as
 * consumeAgentStream. Iteration 1 of an agent turn runs non-streamed because
 * the llama.cpp-based Ollama host honors tool_choice:'required' only for
 * plain completions — under streaming it silently ignores it (verified live
 * 2026-09-07). Content, when present, is forwarded as a single text delta so
 * downstream emit/preamble handling stays identical.
 */
export async function consumeAgentJson(
  upstream: globalThis.Response,
  onTextDelta: (delta: string) => void,
): Promise<AgentStreamResult> {
  let body: any;
  try {
    body = await upstream.json();
  } catch {
    return { text: '', toolCalls: [], finishReason: null };
  }
  const choice = body?.choices?.[0];
  const message = choice?.message ?? {};
  const text = typeof message.content === 'string' ? message.content : '';
  if (text) onTextDelta(text);
  const toolCalls: UpstreamToolCall[] = (message.tool_calls ?? []).map((tc: any) => ({
    id: String(tc?.id ?? ''),
    name: String(tc?.function?.name ?? ''),
    arguments: String(tc?.function?.arguments ?? ''),
  }));
  return { text, toolCalls, finishReason: choice?.finish_reason ?? null };
}
