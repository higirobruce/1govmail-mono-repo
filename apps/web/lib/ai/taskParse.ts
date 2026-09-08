import { parseJsonObject } from '@email-client/shared';
import { fenceUntrusted, neutralizeMarkers } from '@/lib/ai/prompt';

export type ParsedPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export interface ParsedTask {
  title: string;
  dueDate: string | null;
  priority: ParsedPriority | null;
}

const PRIORITIES: ReadonlySet<string> = new Set(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const SYSTEM = (todayIso: string, weekday: string) => `You are a task-entry parser for a busy professional's task list. The user types a short, informal note describing a task, sometimes mentioning a date, deadline, or urgency. Extract structured fields from it.

Today is ${todayIso} (${weekday}). Resolve any relative dates ("Friday", "tomorrow", "next week", "in 3 days") against this reference date.

Output ONLY a strict JSON object with exactly these keys:
{"title": string, "dueDate": "YYYY-MM-DD" or null, "priority": "LOW" | "MEDIUM" | "HIGH" | "URGENT" or null}

Rules:
- "title" is the action itself, with any date/deadline phrase and urgency words removed — a short, clean task title.
- "dueDate" is the resolved calendar date in YYYY-MM-DD form, or null if no date is stated or implied.
- "priority" reflects urgency language in the note ("urgent", "asap", "whenever", "low priority", etc.), or null if none is stated.
- No commentary, no markdown, no preamble — JSON only.`;

/** Deterministic fallback used whenever the model call fails or returns unusable output. */
export function fallbackParse(input: string): ParsedTask {
  return { title: input.trim(), dueDate: null, priority: null };
}

export async function parseTaskInput(
  client: { chat(opts: any): Promise<string> },
  input: string,
  opts: { model: string; now?: Date; signal?: AbortSignal },
): Promise<ParsedTask> {
  try {
    const now = opts.now ?? new Date();
    const todayIso = now.toISOString().slice(0, 10);
    const weekday = WEEKDAYS[now.getUTCDay()];

    const raw = await client.chat({
      model: opts.model,
      messages: [
        { role: 'system', content: SYSTEM(todayIso, weekday) },
        { role: 'user', content: fenceUntrusted('TASK_INPUT', neutralizeMarkers(input)) },
      ],
      temperature: 0.1,
      maxTokens: 200,
      responseFormat: 'json',
      signal: opts.signal,
    });

    const data = parseJsonObject(raw);
    if (!data) return fallbackParse(input);

    const title = typeof data.title === 'string' ? data.title.trim() : '';
    if (!title) return fallbackParse(input);

    const dueDate = typeof data.dueDate === 'string' && DATE_RE.test(data.dueDate) ? data.dueDate : null;
    const priority = typeof data.priority === 'string' && PRIORITIES.has(data.priority)
      ? (data.priority as ParsedPriority)
      : null;

    return { title, dueDate, priority };
  } catch {
    return fallbackParse(input);
  }
}
