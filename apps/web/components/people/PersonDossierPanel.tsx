'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { X, ArrowDownLeft, ArrowUpRight, Loader2, Sparkles } from 'lucide-react';
import { api, type PersonDossier } from '@/lib/api';
import { getCachedDossier, streamDossier, type CachedGeneration } from '@/lib/ai/generation';
import type { AskSource, AskSourceType } from '@/lib/ai/ask';
import { sourceHref } from '@/lib/ai/sourceNav';
import { usePeopleStore } from '@/stores/people.store';
import { useAskStore } from '@/stores/ask.store';
import { useAIStore } from '@/stores/ai.store';
import { MailAvatar } from '@/components/mail/MailAvatar';
import { GenerationAnswer } from '@/components/ai/GenerationAnswer';
import { cn } from '@/lib/utils';

function relative(iso: string | null): string {
  if (!iso) return '';
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return '';
  }
}

/**
 * Docked "who is this person" panel — facts (deterministic, from
 * GET /people/dossier) plus an optional AI-generated relationship narrative
 * (streamed or served from cache). Single mount in the app layout, same
 * pattern as AskPanel: `fixed inset-y-0 right-0`, mutually exclusive with
 * Ask 1Gov when docked (see stores/people.store.ts and stores/ask.store.ts).
 *
 * Docking classes copied verbatim from AskPanel.tsx (not extracted — see
 * GenerationAnswer.tsx's header comment for why).
 */
export default function PersonDossierPanel() {
  const router = useRouter();
  const pathname = usePathname();
  const open = usePeopleStore((s) => s.open);
  const target = usePeopleStore((s) => s.target);
  const closeStore = usePeopleStore((s) => s.close);
  const askOpen = useAskStore((s) => s.open);
  const setAskOpenTarget = useAskStore((s) => s.setOpenTarget);
  const aiEnabled = useAIStore((s) => s.enabled);

  const [facts, setFacts] = useState<PersonDossier | null>(null);
  const [factsLoading, setFactsLoading] = useState(false);
  const [factsError, setFactsError] = useState<string | null>(null);

  const [narrative, setNarrative] = useState<CachedGeneration | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [buffer, setBuffer] = useState('');
  const [streamSources, setStreamSources] = useState<AskSource[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const streamSourcesRef = useRef<AskSource[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const email = target?.email ?? null;

  // Effect 1: (re)load facts + cached narrative whenever the target changes.
  useEffect(() => {
    abortRef.current?.abort();
    setFacts(null);
    setFactsError(null);
    setNarrative(null);
    setStreaming(false);
    setBuffer('');
    setStreamSources([]);
    setStreamError(null);
    streamSourcesRef.current = [];
    if (!open || !email) return;
    let mounted = true;
    setFactsLoading(true);
    api.people.dossier(email)
      .then((d) => { if (mounted) setFacts(d); })
      .catch((e) => { if (mounted) setFactsError(String(e?.message ?? e)); })
      .finally(() => { if (mounted) setFactsLoading(false); });
    getCachedDossier(email)
      .then((cached) => { if (mounted && cached) setNarrative(cached); })
      .catch(() => { /* cache miss is never fatal */ });
    return () => { mounted = false; };
  }, [open, email]);

  // Effect 2: mutual exclusion (ask side) — the ask store closes THIS panel
  // when it opens; this side closes the ask panel from openDossier() itself.
  useEffect(() => {
    if (askOpen) usePeopleStore.getState().close();
  }, [askOpen]);

  // Effect 3: Escape closes.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') closeStore(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, closeStore]);

  // Abort any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  function openSource(s: { type: AskSourceType; id: string }) {
    const href = sourceHref(s);
    if (pathname === href.split('?')[0]) { setAskOpenTarget(s); return; }
    router.push(href);
  }

  function startStream() {
    if (!email || streaming) return;
    setStreaming(true);
    setBuffer('');
    setStreamSources([]);
    streamSourcesRef.current = [];
    setStreamError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    streamDossier(email, {
      onSources: (sources) => { streamSourcesRef.current = sources; setStreamSources(sources); },
      onChunk: (delta) => setBuffer((b) => b + delta),
      signal: ac.signal,
    })
      .then((full) => {
        setNarrative({ content: full, sources: streamSourcesRef.current, generatedAt: new Date().toISOString(), stale: false });
      })
      .catch((e) => { if (!ac.signal.aborted) setStreamError(String(e?.message ?? e)); })
      .finally(() => setStreaming(false));
  }

  if (!open || !target) return null;

  const displayName = facts?.profile.name ?? target.name ?? target.email;
  const lastSeen = facts?.profile.lastSeenAt ?? null;

  return (
    <aside
      role="complementary"
      aria-label="Person dossier"
      className={cn(
        'fixed inset-y-0 right-0 z-[41] w-full max-w-[420px]',
        'border-l border-border/40 bg-card shadow-xl',
        'flex flex-col overflow-hidden',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/30 shrink-0">
        <MailAvatar name={displayName} email={target.email} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.8125rem] font-semibold text-foreground">{displayName}</p>
          {lastSeen && (
            <p className="truncate text-[0.6875rem] text-muted-foreground/70">
              Last interaction {relative(lastSeen)}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={closeStore}
          className="p-1 rounded text-ink-3 hover:text-foreground hover:bg-muted/60 transition-colors"
          aria-label="Close"
          title="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-[0.75rem]">
        {factsLoading && !facts && (
          <div className="flex items-center gap-2 py-4 text-muted-foreground/70">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="text-[0.75rem]">Loading…</span>
          </div>
        )}

        {factsError && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[0.719rem] text-amber-800 dark:text-amber-300">
            {factsError}
          </div>
        )}

        {facts && facts.recentConversations.length > 0 && (
          <section className="space-y-1.5">
            <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground/70">
              Recent conversations
            </h3>
            <ul className="space-y-1">
              {facts.recentConversations.map((c) => (
                <li key={c.messageId}>
                  <button
                    type="button"
                    onClick={() => openSource({ type: 'mail', id: c.messageId })}
                    className="w-full rounded-md border border-border/30 p-2 text-left hover:bg-muted/40 transition-colors space-y-0.5"
                  >
                    <div className="flex items-center gap-1.5">
                      {c.direction === 'in' ? (
                        <ArrowDownLeft className="h-3 w-3 shrink-0 text-muted-foreground/60" aria-hidden />
                      ) : (
                        <ArrowUpRight className="h-3 w-3 shrink-0 text-muted-foreground/60" aria-hidden />
                      )}
                      <span className="min-w-0 flex-1 truncate text-[0.75rem] font-medium text-foreground">
                        {c.subject ?? '(no subject)'}
                      </span>
                      <span className="shrink-0 text-[0.625rem] text-muted-foreground/60">{relative(c.at)}</span>
                    </div>
                    {c.snippet && <p className="line-clamp-2 text-[0.6875rem] text-muted-foreground/70">{c.snippet}</p>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {facts && facts.commitments.length > 0 && (
          <section className="space-y-1.5">
            <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground/70">
              Open loops
            </h3>
            {(['promised', 'waiting'] as const).map((kind) => {
              const items = facts.commitments.filter((c) => c.type === kind);
              if (items.length === 0) return null;
              return (
                <div key={kind} className="space-y-1">
                  <p className="text-[0.6875rem] font-medium text-foreground/80">
                    {kind === 'promised' ? 'You promised' : 'Waiting on them'}
                  </p>
                  <ul className="space-y-1">
                    {items.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => openSource({ type: 'mail', id: c.messageId })}
                          className="w-full rounded-md border border-border/30 p-2 text-left hover:bg-muted/40 transition-colors"
                        >
                          <p className="text-[0.75rem] text-foreground">{c.text}</p>
                          {c.dueHint && <p className="text-[0.625rem] text-muted-foreground/60">{c.dueHint}</p>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </section>
        )}

        {facts && facts.sharedEvents.length > 0 && (
          <section className="space-y-1.5">
            <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground/70">
              Shared events
            </h3>
            <ul className="space-y-1">
              {[...facts.sharedEvents].sort((a, b) => Number(b.upcoming) - Number(a.upcoming)).map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => openSource({ type: 'event', id: e.id })}
                    className="w-full rounded-md border border-border/30 p-2 text-left hover:bg-muted/40 transition-colors flex items-center justify-between gap-2"
                  >
                    <span className="truncate text-[0.75rem] font-medium text-foreground">{e.title}</span>
                    <span className="shrink-0 text-[0.625rem] text-muted-foreground/60">
                      {new Date(e.startAt).toLocaleDateString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {facts && facts.sharedDocs.length > 0 && (
          <section className="space-y-1.5">
            <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground/70">
              Shared docs
            </h3>
            <ul className="space-y-1">
              {facts.sharedDocs.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => openSource({ type: 'doc', id: d.id })}
                    className="w-full rounded-md border border-border/30 p-2 text-left hover:bg-muted/40 transition-colors flex items-center gap-2"
                  >
                    <span className="shrink-0">{d.emoji ?? '📄'}</span>
                    <span className="min-w-0 flex-1 truncate text-[0.75rem] font-medium text-foreground">{d.title}</span>
                    <span className="shrink-0 text-[0.625rem] text-muted-foreground/60">
                      {d.direction === 'i-shared' ? 'You shared' : 'They shared'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* AI block — hidden entirely when the app-wide AI switch is off,
            same as every other AI trigger (AskLauncher, mail-page rail). A
            cached narrative fetched before AI was disabled is not shown
            either, since its Regenerate action is itself a generation
            trigger and must not render while the switch is off. */}
        {aiEnabled && (
        <section className="space-y-2 border-t border-border/30 pt-3">
          {!narrative && !streaming && (
            <button
              type="button"
              onClick={startStream}
              disabled={!email}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[0.75rem] font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Summarize relationship
            </button>
          )}

          {streaming && (
            <GenerationAnswer content={buffer} sources={streamSources} streaming onSourceClick={openSource} />
          )}

          {!streaming && narrative && (
            <div className="space-y-1.5">
              <GenerationAnswer content={narrative.content} sources={narrative.sources} onSourceClick={openSource} />
              <p className="text-[0.625rem] text-muted-foreground/60">
                Generated {relative(narrative.generatedAt)}
              </p>
              {narrative.stale && (
                <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[0.6875rem] text-amber-800 dark:text-amber-300">
                  <span>Stale — newer mail since this was generated</span>
                  <button
                    type="button"
                    onClick={startStream}
                    className="shrink-0 font-medium underline hover:no-underline"
                  >
                    Regenerate
                  </button>
                </div>
              )}
              {!narrative.stale && (
                <button
                  type="button"
                  onClick={startStream}
                  className="text-[0.6875rem] font-medium text-primary hover:underline"
                >
                  Regenerate
                </button>
              )}
            </div>
          )}

          {!streaming && streamError && (
            <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[0.719rem] text-amber-800 dark:text-amber-300">
              <span className="min-w-0 break-words">{streamError}</span>
              <button
                type="button"
                onClick={startStream}
                className="shrink-0 font-medium underline hover:no-underline"
              >
                Retry
              </button>
            </div>
          )}
        </section>
        )}
      </div>
    </aside>
  );
}
