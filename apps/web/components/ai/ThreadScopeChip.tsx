'use client';

import { MessageSquare, ShieldAlert, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  subject: string | null;
  /** True thread length. */
  messageCount: number;
  /** How many messages actually reached the model; null until the server acks. */
  included: number | null;
  locked: boolean;
  injectionSuspected: boolean;
  onToggleLock: () => void;
  onClear: () => void;
}

/** "N messages", or "N of M messages" when the character budget dropped the oldest. */
function countLabel(messageCount: number, included: number | null): string {
  const plural = messageCount === 1 ? 'message' : 'messages';
  if (included !== null && included < messageCount) return `${included} of ${messageCount} ${plural}`;
  return `${messageCount} ${plural}`;
}

/**
 * Presentational chip showing the mail thread pinned as Ask 1Gov context,
 * mirroring the "This document: …" scope chip's shell (AskPanel.tsx) so the
 * two read as siblings. Purely props in / callbacks out — no store access.
 */
export default function ThreadScopeChip({
  subject,
  messageCount,
  included,
  locked,
  injectionSuspected,
  onToggleLock,
  onClear,
}: Props) {
  return (
    <span
      className={cn(
        'inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border/40 bg-muted/50 px-2 py-0.5 text-[0.6875rem] text-foreground',
        locked && 'border-primary/40 bg-primary/5',
      )}
    >
      <MessageSquare className="h-3 w-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
      <span className="truncate">{subject ?? '(no subject)'}</span>
      <span className="shrink-0 text-muted-foreground/70">{countLabel(messageCount, included)}</span>

      {injectionSuspected && (
        <ShieldAlert
          role="img"
          aria-label="This thread contains suspicious content"
          className="h-3 w-3 shrink-0 text-destructive"
        />
      )}

      <button
        type="button"
        onClick={onToggleLock}
        aria-pressed={locked}
        aria-label="Only this thread"
        title="Answer using only this thread"
        className={cn(
          'shrink-0 rounded px-1 text-[0.625rem] font-medium uppercase tracking-wide transition-colors',
          locked ? 'text-primary' : 'text-muted-foreground/70 hover:text-foreground',
        )}
      >
        Only
      </button>

      <button
        type="button"
        onClick={onClear}
        aria-label="Remove thread context"
        title="Remove thread context"
        className="shrink-0 text-muted-foreground/70 hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
