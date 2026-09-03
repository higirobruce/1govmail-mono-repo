'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  ClipboardCheck, X, Check, CornerUpRight, RotateCcw, Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, type Commitment, type CommitmentsResponse } from '@/lib/api';
import { cn } from '@/lib/utils';

type View = 'open' | 'archived';

const SECTIONS: Array<[Commitment['type'], string]> = [
  ['promised', 'You promised'],
  ['waiting', 'Waiting on'],
];

function daysAgoLabel(commitment: Commitment): string {
  const ago = formatDistanceToNow(new Date(commitment.lastActivityAt), { addSuffix: true });
  return commitment.counterparty ? `${commitment.counterparty} · ${ago}` : ago;
}

/**
 * Commitments ledger drawer. Unlike BriefingPanel there is no expensive
 * analysis to preserve across a close — closing is fine, reopening just
 * reuses/refetches the cheap `['commitments', …]` queries, so this panel
 * keeps simple `open`/`onClose` state instead of BriefingPanel's pill pattern.
 */
export default function CommitmentsPanel({
  open, onClose, onOpenMessage, data, isLoading, onMutated,
}: {
  open: boolean;
  onClose: () => void;
  onOpenMessage: (messageId: string) => void;
  /** The 'open' view's data — owned by the caller's always-mounted badge query. */
  data: CommitmentsResponse | undefined;
  isLoading: boolean;
  /** Called after any row mutation succeeds; the caller invalidates ['commitments']. */
  onMutated: () => void;
}) {
  const [view, setView] = useState<View>('open');
  const [pendingId, setPendingId] = useState<string | null>(null);

  const { data: archivedData, isLoading: archivedLoading } = useQuery({
    queryKey: ['commitments', 'archived'],
    queryFn: () => api.mail.getCommitments('archived'),
    enabled: open && view === 'archived',
  });

  // Escape closes — this panel isn't modal, but Escape is the expected exit.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Reset to the open view every time the panel is reopened.
  useEffect(() => {
    if (open) setView('open');
  }, [open]);

  if (!open) return null;

  const active = view === 'archived' ? archivedData : data;
  const activeLoading = view === 'archived' ? archivedLoading : isLoading;
  const allEmpty = !!active && active.promised.length === 0 && active.waiting.length === 0;

  async function runAction(id: string, fn: () => Promise<unknown>) {
    setPendingId(id);
    try {
      await fn();
      onMutated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setPendingId(null);
    }
  }

  return (
    <aside
      role="complementary"
      aria-label="Commitments"
      className={cn(
        // z-[41]: above the briefing drawer when both are open — explicit, not mount-order luck.
        'fixed inset-y-0 right-0 z-[41] w-full max-w-[420px]',
        'border-l border-border/40 bg-card shadow-xl',
        'flex flex-col overflow-hidden',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/30 shrink-0">
        <ClipboardCheck className="w-4 h-4 text-primary" />
        <span className="text-[12px] font-semibold text-foreground">Commitments</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto p-1 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
          aria-label="Close"
          title="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* View toggle */}
      <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-border/30 shrink-0">
        <button
          type="button"
          onClick={() => setView('open')}
          className={cn(
            'px-2 py-1 rounded-md text-[11px] font-medium transition-colors',
            view === 'open'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground/60 hover:text-foreground hover:bg-muted/60',
          )}
        >
          Open
        </button>
        <button
          type="button"
          onClick={() => setView('archived')}
          className={cn(
            'px-2 py-1 rounded-md text-[11px] font-medium transition-colors',
            view === 'archived'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground/60 hover:text-foreground hover:bg-muted/60',
          )}
        >
          Archived (idle)
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-[12px]">
        {activeLoading && (
          <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-muted-foreground/70">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>Loading…</span>
          </div>
        )}

        {!activeLoading && active && allEmpty && (
          <p className="py-6 text-center text-[12px] text-muted-foreground/60">
            {view === 'archived' ? 'No archived commitments.' : 'No open commitments.'}
          </p>
        )}

        {!activeLoading && active && !allEmpty && SECTIONS.map(([type, label]) => {
          const items = active[type];
          if (items.length === 0) return null;
          return (
            <div key={type}>
              <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/50">{label}</p>
              <ul className="space-y-0.5">
                {items.map((c) => {
                  const mutating = pendingId === c.id;
                  return (
                    <li key={c.id} className="group rounded-md hover:bg-muted/60 transition-colors">
                      <div className="flex items-start gap-1.5 px-2 py-1.5">
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => onOpenMessage(c.messageId)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') onOpenMessage(c.messageId);
                          }}
                          className="flex-1 min-w-0 cursor-pointer text-left"
                        >
                          <p className="text-[12px] leading-snug text-foreground">{c.text}</p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted-foreground/60">
                            <span>{daysAgoLabel(c)}</span>
                            {c.dueHint && (
                              <span className="rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground/70">
                                {c.dueHint}
                              </span>
                            )}
                          </div>
                          {c.suggestResolve && c.hintMessageId && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenMessage(c.hintMessageId!);
                              }}
                              className="mt-1 inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-400"
                            >
                              reply received — review
                            </button>
                          )}
                        </div>

                        <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
                          {view === 'archived' ? (
                            <button
                              type="button"
                              disabled={mutating}
                              onClick={() => void runAction(c.id, () => api.mail.updateCommitment(c.id, 'open'))}
                              title="Reopen"
                              aria-label="Reopen"
                              className={cn(
                                'p-1 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted transition-colors',
                                mutating && 'opacity-50 cursor-not-allowed',
                              )}
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                disabled={mutating}
                                onClick={() => void runAction(c.id, () => api.mail.updateCommitment(c.id, 'done'))}
                                title="Mark done"
                                aria-label="Mark done"
                                className={cn(
                                  'p-1 rounded-md text-muted-foreground/50 hover:text-emerald-600 hover:bg-muted transition-colors',
                                  mutating && 'opacity-50 cursor-not-allowed',
                                )}
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                disabled={mutating}
                                onClick={() => void runAction(c.id, () => api.mail.updateCommitment(c.id, 'dismissed'))}
                                title="Dismiss"
                                aria-label="Dismiss"
                                className={cn(
                                  'p-1 rounded-md text-muted-foreground/50 hover:text-destructive hover:bg-muted transition-colors',
                                  mutating && 'opacity-50 cursor-not-allowed',
                                )}
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                disabled={mutating}
                                onClick={() => void runAction(c.id, () => api.mail.promoteCommitment(c.id))}
                                title="Make a task"
                                aria-label="Make a task"
                                className={cn(
                                  'p-1 rounded-md text-muted-foreground/50 hover:text-primary hover:bg-muted transition-colors',
                                  mutating && 'opacity-50 cursor-not-allowed',
                                )}
                              >
                                <CornerUpRight className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-border/30 px-4 py-2.5">
        <p className="text-[10px] text-muted-foreground/45">
          Extracted from your mail — resolve manually; nothing closes itself.
        </p>
      </div>
    </aside>
  );
}
