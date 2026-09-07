'use client';

import { useState } from 'react';
import { authedFetch } from '@/lib/authed-fetch';
import type { AgentProposal } from '@/lib/ai/agent';
import { markdownToHtml } from '@/lib/ai/markdownToHtml';
import { cn } from '@/lib/utils';

type Status = 'idle' | 'working' | 'done' | 'dismissed' | 'error';

const ENDPOINTS: Record<AgentProposal['tool'], { url: string; verb: string; doneLabel: string }> = {
  send_email: { url: '/mail/send', verb: 'Approve & Send', doneLabel: 'Sent ✓' },
  create_calendar_event: { url: '/calendar/events', verb: 'Approve & Create', doneLabel: 'Created ✓' },
};

/**
 * Renders one agent-proposed action (send an email / create a calendar event)
 * awaiting human approval. Self-contained: owns its own approve/dismiss state,
 * POSTs the tool's `args` to the matching approval endpoint (payload contracts
 * fixed in Task 9 — email payloads additionally carry bodyFormat: 'markdown'
 * so the server formats the body and appends the user's signature), and
 * reflects the outcome in place rather than unmounting.
 */
export default function ProposalCard({ proposal }: { proposal: AgentProposal }) {
  const [status, setStatus] = useState<Status>('idle');
  const [doneLabel, setDoneLabel] = useState<string>('Done ✓');
  const [error, setError] = useState<string | null>(null);
  const meta = ENDPOINTS[proposal.tool];

  const post = async (url: string, payload: unknown, label: string) => {
    setStatus('working');
    setError(null);
    try {
      const res = await authedFetch(url, { method: 'POST', body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(`failed (${res.status})`);
      // Functional update: a Dismiss click that lands while this request is
      // still in flight must win — a late resolution must never resurrect a
      // dismissed card as "done" or "error". Dismiss is a sticky terminal state.
      setDoneLabel(label);
      setStatus((s) => (s === 'dismissed' ? s : 'done'));
    } catch (err: any) {
      setError(err?.message ?? 'failed');
      setStatus((s) => (s === 'dismissed' ? s : 'error'));
    }
  };

  if (status === 'dismissed') {
    return (
      <div className="rounded-md border border-dashed border-border/40 p-2 text-[0.6875rem] text-muted-foreground/60">
        Proposal dismissed
      </div>
    );
  }

  const args = proposal.args ?? {};
  return (
    <div
      className="rounded-md border border-border/40 bg-card p-3 text-[0.75rem] text-foreground space-y-2"
      data-proposal={proposal.proposalId}
    >
      <div className="font-medium">
        {proposal.tool === 'send_email' ? 'Send email' : 'Create event'} — needs your approval
      </div>
      {proposal.tool === 'send_email' ? (
        <div className="space-y-1">
          <div className="text-[0.6875rem] text-muted-foreground/70">
            To: {(args.to ?? []).join(', ')}
            {args.cc?.length ? ` · Cc: ${args.cc.join(', ')}` : ''}
          </div>
          <div className="font-medium">{args.subject}</div>
          {/* The body is agent-authored markdown; the server formats it the same
              way on send/save (bodyFormat: 'markdown'), so preview ≈ what goes out.
              markdownToHtml is escape-first + DOMPurify — safe for innerHTML. */}
          <div
            className="prose-sm text-[0.6875rem] max-h-48 overflow-y-auto text-foreground/90 [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_ul]:pl-4 [&_ol]:pl-4 [&_ul]:list-disc [&_ol]:list-decimal"
            dangerouslySetInnerHTML={{ __html: markdownToHtml(args.body ?? '') }}
          />
        </div>
      ) : (
        <div className="space-y-1 text-[0.6875rem]">
          <div className="font-medium text-[0.75rem]">{args.title}</div>
          <div className="text-muted-foreground/70">{args.startAt} → {args.endAt}</div>
          {args.location ? <div className="text-muted-foreground/70">@ {args.location}</div> : null}
          {args.attendees?.length ? <div className="text-muted-foreground/70">With: {args.attendees.join(', ')}</div> : null}
          {args.description ? <div className="text-muted-foreground/60">{args.description}</div> : null}
        </div>
      )}
      {status === 'done' ? (
        <div className="text-[0.6875rem] text-green-600 dark:text-green-400">{doneLabel}</div>
      ) : (
        <div className="flex gap-2 items-center flex-wrap">
          <button
            type="button"
            disabled={status === 'working'}
            onClick={() =>
              post(
                meta.url,
                proposal.tool === 'send_email' ? { ...args, bodyFormat: 'markdown' } : args,
                meta.doneLabel,
              )
            }
            className={cn(
              'rounded-md bg-primary px-2 py-1 text-[0.6875rem] text-primary-foreground transition-colors',
              status === 'working' ? 'opacity-50' : 'hover:bg-primary/90',
            )}
          >
            {meta.verb}
          </button>
          {proposal.tool === 'send_email' && (
            <button
              type="button"
              disabled={status === 'working'}
              onClick={() => post('/mail/drafts', { to: args.to, cc: args.cc, subject: args.subject, body: args.body, bodyFormat: 'markdown' }, 'Saved to Drafts ✓')}
              className={cn(
                'rounded-md border border-border/40 px-2 py-1 text-[0.6875rem] text-foreground transition-colors',
                status === 'working' ? 'opacity-50' : 'hover:bg-muted/60',
              )}
            >
              Save as draft instead
            </button>
          )}
          <button
            type="button"
            disabled={status === 'working'}
            onClick={() => setStatus('dismissed')}
            className={cn(
              'rounded-md px-2 py-1 text-[0.6875rem] text-muted-foreground/70 transition-colors',
              status === 'working' ? 'opacity-50' : 'hover:text-foreground',
            )}
          >
            Dismiss
          </button>
          {status === 'error' && (
            <span className="text-[0.6875rem] text-red-600 dark:text-red-400">{error ?? 'failed'} — try again</span>
          )}
        </div>
      )}
    </div>
  );
}
