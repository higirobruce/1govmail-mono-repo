'use client';

import { useState } from 'react';
import type { AgentStep } from '@/lib/ai/agent';

const LABELS: Record<string, string> = {
  search_emails: 'Searched mail',
  read_email: 'Read email',
  get_thread: 'Read thread',
  read_attachment: 'Read attachment',
  search_documents: 'Searched docs',
  read_document: 'Read document',
  compare_documents: 'Compared documents',
  list_events: 'Checked calendar',
  get_freebusy: 'Checked availability',
  get_person: 'Looked up person',
  search_contacts: 'Searched contacts',
  list_tasks: 'Checked tasks',
  get_mail_stats: 'Counted mail',
  draft_email: 'Saved a draft',
  create_document: 'Created a document',
  create_task: 'Created a task',
  send_email: 'Proposed an email',
  create_calendar_event: 'Proposed an event',
  create_chart: 'Rendered a chart',
};

/**
 * Collapsible timeline of the tool calls behind one agent answer. Collapsed by
 * default — the answer is the product, the steps are the receipt. Rendered live
 * while streaming (steps arrive as `tool_start`, then get patched in place by
 * `tool_result`) and again on the completed turn.
 */
export default function AgentSteps({ steps }: { steps: AgentStep[] }) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  return (
    <div className="mb-1 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-muted-foreground/70 hover:text-foreground transition-colors"
      >
        {open ? '▾' : '▸'} {steps.length} step{steps.length > 1 ? 's' : ''}
      </button>
      {open && (
        <ol className="mt-1 space-y-0.5 border-l border-border/40 pl-2 text-[0.6875rem] text-muted-foreground/80">
          {steps.map((s) => (
            <li key={s.id} className={s.ok === false ? 'text-red-600 dark:text-red-400' : ''}>
              {s.preamble && (
                <p className="italic text-muted-foreground/60">{s.preamble}</p>
              )}
              {LABELS[s.tool] ?? s.tool} {s.argsSummary}
              {s.summary ? ` — ${s.summary}` : s.ok === undefined ? ' …' : ''}
              {s.injectionSuspected ? ' ⚠' : ''}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
