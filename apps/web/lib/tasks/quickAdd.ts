import { parseTaskInput, fallbackParse, type ParsedTask } from '@/lib/ai/taskParse';

/**
 * Natural-language task quick-add: parses free text into a title plus
 * optional dueDate/priority (via the model when AI is enabled, or a
 * deterministic passthrough when it isn't — parseTaskInput/fallbackParse
 * never throw), then creates the task with only the fields that were
 * actually extracted.
 */
export async function quickAddTask(
  input: string,
  deps: {
    enabled: boolean;
    model: string;
    client: { chat(o: any): Promise<string> };
    create: (p: any) => Promise<any>;
    signal?: AbortSignal;
  },
): Promise<{ task: any; parsed: ParsedTask }> {
  const parsed = deps.enabled
    ? await parseTaskInput(deps.client, input, { model: deps.model, signal: deps.signal })
    : fallbackParse(input);
  // parseTaskInput swallows AbortError internally and falls back — so a
  // caller that aborted (e.g. the page unmounted) would otherwise still
  // create a task from the fallback parse. Surface the abort here instead.
  if (deps.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const task = await deps.create({
    title: parsed.title,
    ...(parsed.dueDate ? { dueDate: parsed.dueDate } : {}),
    ...(parsed.priority ? { priority: parsed.priority } : {}),
  });
  return { task, parsed };
}
