import { parseEventInput } from '@/lib/ai/eventParse';
import type { AIClient } from '@/lib/ai/client';

export interface QuickAddEventDeps {
  enabled: boolean;
  model: string;
  client: Pick<AIClient, 'chat'>;
  now?: Date;
  signal?: AbortSignal;
}

export interface QuickAddEventPrefill {
  title: string;
  startAt?: string;
  endAt?: string;
  allDay?: boolean;
  location?: string;
  attendees?: string[];
}

/**
 * Natural-language event quick-add: parses free text into event fields (via
 * the model when AI is enabled, or a deterministic passthrough when it
 * isn't — parseEventInput never throws), mapped down to only the fields
 * that were actually extracted so the create form's own defaults apply to
 * the rest. This never creates an event — it only produces a prefill for
 * the create modal, which still requires an explicit save.
 */
export async function quickAddEventPrefill(
  input: string,
  deps: QuickAddEventDeps,
): Promise<QuickAddEventPrefill> {
  if (!deps.enabled) {
    return { title: input.trim() };
  }

  const parsed = await parseEventInput(deps.client, input, {
    model: deps.model,
    now: deps.now,
    signal: deps.signal,
  });

  // parseEventInput swallows AbortError internally and falls back — so a
  // caller that aborted (e.g. the quick-add form was resubmitted, or the
  // page unmounted) would otherwise still open the modal from the fallback
  // parse. Surface the abort here instead.
  if (deps.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  return {
    title: parsed.title,
    ...(parsed.startAt ? { startAt: parsed.startAt } : {}),
    ...(parsed.endAt ? { endAt: parsed.endAt } : {}),
    ...(parsed.allDay ? { allDay: true } : {}),
    ...(parsed.location ? { location: parsed.location } : {}),
    ...(parsed.attendees.length ? { attendees: parsed.attendees } : {}),
  };
}
