'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, X, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { AIClient } from '@/lib/ai/client';
import { api } from '@/lib/api';
import { useAIStore } from '@/stores/ai.store';
import {
  generateBriefing, type BriefingWindow, type BriefingResult, type BriefingProgress, type BriefItem,
} from '@/lib/ai/briefing';
import { cn } from '@/lib/utils';

const WINDOWS: Array<[BriefingWindow, string]> = [['today', 'Today'], ['24h', 'Last 24h'], ['week', 'This week']];
const SECTIONS: Array<[keyof BriefingResult['brief'], string]> = [
  ['needsDecision', 'Needs your decision'],
  ['waitingOnYou', 'Waiting on you'],
  ['youPromised', 'You promised'],
  ['deadlines', 'Deadlines ahead'],
  ['worthKnowing', 'Worth knowing'],
];

function phaseLabel(p: BriefingProgress): string {
  if (p.phase === 'fetch') return 'Reading mailbox…';
  if (p.phase === 'compose') return 'Composing brief…';
  return `Analyzed ${p.done}/${p.total} messages…`;
}

export default function BriefingPanel({ open, onClose, onOpenMessage }: {
  open: boolean; onClose: () => void; onOpenMessage: (messageId: string) => void;
}) {
  const model = useAIStore((s) => s.model);
  const [window_, setWindow] = useState<BriefingWindow>('24h');
  const [result, setResult] = useState<BriefingResult | null>(null);
  const [progress, setProgress] = useState<BriefingProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async (win: BriefingWindow) => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setResult(null); setError(null); setProgress(null); setRunning(true);
    try {
      const res = await generateBriefing(
        { client: new AIClient(), mail: api.mail, model },
        { window: win, signal: abort.signal },
        (p) => { if (!abort.signal.aborted) setProgress(p); },
      );
      if (!abort.signal.aborted) setResult(res);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // Only clear `running` if this call is still the active one — an
      // earlier, already-aborted run's finally must not stomp on a newer
      // run's in-flight state.
      if (abortRef.current === abort) setRunning(false);
    }
  }, [model]);

  // Auto-run on open; abort on close/unmount.
  useEffect(() => {
    if (open) void run(window_);
    else abortRef.current?.abort();
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Escape closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const allEmpty = !!result && SECTIONS.every(([key]) => result.brief[key].length === 0);

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/10 dark:bg-black/30"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-label="Executive briefing"
        className={cn(
          'fixed inset-y-0 right-0 z-50 w-full max-w-[420px]',
          'border-l border-border/40 bg-card shadow-xl',
          'flex flex-col overflow-hidden',
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/30 shrink-0">
          <Sparkles className="w-4 h-4 text-primary" />
          <span className="text-[12px] font-semibold text-foreground">Executive briefing</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto p-1 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
            aria-label="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Window chips + regenerate */}
        <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-border/30 shrink-0">
          {WINDOWS.map(([w, label]) => (
            <button
              key={w}
              type="button"
              disabled={running}
              onClick={() => { setWindow(w); void run(w); }}
              className={cn(
                'px-2 py-1 rounded-md text-[11px] font-medium transition-colors',
                w === window_
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground/60 hover:text-foreground hover:bg-muted/60',
                running && 'opacity-50 cursor-not-allowed',
              )}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            disabled={running}
            onClick={() => void run(window_)}
            title="Regenerate"
            aria-label="Regenerate"
            className={cn(
              'ml-auto p-1.5 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors',
              running && 'opacity-50 cursor-not-allowed',
            )}
          >
            <RefreshCw className={cn('w-3.5 h-3.5', running && 'animate-spin')} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-[12px]">
          {running && (
            <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-muted-foreground/70">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>{progress ? phaseLabel(progress) : 'Starting…'}</span>
            </div>
          )}

          {!running && error && (
            <div className="space-y-2.5">
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11.5px] leading-relaxed text-amber-800 dark:text-amber-300">
                {error}
              </div>
              <button
                type="button"
                onClick={() => void run(window_)}
                className="text-[11.5px] font-medium text-primary hover:underline"
              >
                Retry
              </button>
            </div>
          )}

          {!running && !error && result && allEmpty && (
            <p className="py-6 text-center text-[12px] text-muted-foreground/60">
              Nothing needs your attention in this window.
            </p>
          )}

          {!running && !error && result && !allEmpty && SECTIONS.map(([key, label]) => {
            const items = result.brief[key];
            if (items.length === 0) return null;
            return (
              <div key={key}>
                <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/50">{label}</p>
                <ul className="space-y-1">
                  {items.map((item: BriefItem, i: number) => {
                    const clickable = item.messageIds.length > 0;
                    return (
                      <li key={i}>
                        <button
                          type="button"
                          disabled={!clickable}
                          onClick={() => clickable && onOpenMessage(item.messageIds[0])}
                          className={cn(
                            'flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] leading-snug transition-colors',
                            clickable
                              ? 'cursor-pointer text-foreground hover:bg-muted/60'
                              : 'cursor-default text-foreground/80',
                          )}
                        >
                          {item.flagged && (
                            <span title="Verify at source" className="mt-0.5 shrink-0">
                              <AlertTriangle
                                className="h-3 w-3 text-amber-600 dark:text-amber-400"
                                aria-label="Verify at source"
                              />
                            </span>
                          )}
                          <span className="flex-1">{item.text}</span>
                          {item.messageIds.length > 1 && (
                            <span className="shrink-0 rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground/50">
                              {item.messageIds.length} sources
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="shrink-0 space-y-1 border-t border-border/30 px-4 py-2.5">
          {result && (
            <p className="text-[11px] text-muted-foreground/60">
              Covered {result.coveredCount} of {result.totalInWindow}{result.totalIsLowerBound ? '+' : ''} messages
              {result.failedCount > 0 && ` · ${result.failedCount} could not be analyzed`}
              {' · '}
              {new Date(result.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </p>
          )}
          <p className="text-[10px] text-muted-foreground/45">
            AI-generated — verify against the linked messages.
          </p>
        </div>
      </aside>
    </>
  );
}
