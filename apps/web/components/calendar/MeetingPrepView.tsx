'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { BookOpenCheck } from 'lucide-react';
import { getCachedMeetingPrep, streamMeetingPrep, type CachedGeneration } from '@/lib/ai/generation';
import type { AskSource, AskSourceType } from '@/lib/ai/ask';
import { sourceHref } from '@/lib/ai/sourceNav';
import { useAskStore } from '@/stores/ask.store';
import { GenerationAnswer } from '@/components/ai/GenerationAnswer';

function relative(iso: string | null): string {
  if (!iso) return '';
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return '';
  }
}

/**
 * "Meeting prep" block in the calendar event detail panel (Task 10) — an
 * AI-generated one-shot brief for an upcoming event, cached or streamed,
 * rendered through GenerationAnswer. Same cache/stream state machine as
 * PersonDossierPanel's AI block (Task 8/9): fetch the cache on mount (keyed
 * here by eventId instead of email), a generate/regenerate button, a
 * streaming buffer, and AbortController cleanup on unmount.
 *
 * openSource() below is COPIED verbatim from PersonDossierPanel's helper of
 * the same name — not extracted into a shared util, see that file's header
 * comment for why (recorded follow-up debt).
 */
export function MeetingPrepView({ eventId }: { eventId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const setAskOpenTarget = useAskStore((s) => s.setOpenTarget);

  const [cached, setCached] = useState<CachedGeneration | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [buffer, setBuffer] = useState('');
  const [streamSources, setStreamSources] = useState<AskSource[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const streamSourcesRef = useRef<AskSource[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // (Re)load the cached pack whenever the event changes.
  useEffect(() => {
    abortRef.current?.abort();
    setCached(null);
    setStreaming(false);
    setBuffer('');
    setStreamSources([]);
    setStreamError(null);
    streamSourcesRef.current = [];
    if (!eventId) return;
    let mounted = true;
    getCachedMeetingPrep(eventId)
      .then((c) => { if (mounted && c) setCached(c); })
      .catch(() => { /* cache miss is never fatal — the view just shows the generate button */ });
    return () => { mounted = false; };
  }, [eventId]);

  // Abort any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  function openSource(s: { type: AskSourceType; id: string }) {
    const href = sourceHref(s);
    if (pathname === href.split('?')[0]) { setAskOpenTarget(s); return; }
    router.push(href);
  }

  function startStream() {
    if (!eventId || streaming) return;
    setStreaming(true);
    setBuffer('');
    setStreamSources([]);
    streamSourcesRef.current = [];
    setStreamError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    streamMeetingPrep(eventId, {
      onSources: (sources) => { streamSourcesRef.current = sources; setStreamSources(sources); },
      onChunk: (delta) => setBuffer((b) => b + delta),
      signal: ac.signal,
    })
      .then((full) => {
        setCached({ content: full, sources: streamSourcesRef.current, generatedAt: new Date().toISOString(), stale: false });
      })
      .catch((e) => { if (!ac.signal.aborted) setStreamError(String(e?.message ?? e)); })
      .finally(() => setStreaming(false));
  }

  return (
    <section className="space-y-2 border-t border-border/30 pt-3">
      <p className="text-[0.625rem] uppercase tracking-wider text-muted-foreground/40 font-medium">
        Meeting prep
      </p>

      {!cached && !streaming && (
        <button
          type="button"
          onClick={startStream}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[0.75rem] font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <BookOpenCheck className="h-3.5 w-3.5" />
          Prepare me for this meeting
        </button>
      )}

      {streaming && (
        <GenerationAnswer content={buffer} sources={streamSources} streaming onSourceClick={openSource} />
      )}

      {!streaming && cached && (
        <div className="space-y-1.5">
          <GenerationAnswer content={cached.content} sources={cached.sources} onSourceClick={openSource} />
          <p className="text-[0.625rem] text-muted-foreground/60">
            Generated {relative(cached.generatedAt)}
          </p>
          {cached.stale && (
            <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[0.6875rem] text-amber-800 dark:text-amber-300">
              <span>Stale — newer info since this was generated</span>
              <button
                type="button"
                onClick={startStream}
                className="shrink-0 font-medium underline hover:no-underline"
              >
                Regenerate
              </button>
            </div>
          )}
          {!cached.stale && (
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
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[0.719rem] text-amber-800 dark:text-amber-300">
          {streamError}
        </div>
      )}
    </section>
  );
}
