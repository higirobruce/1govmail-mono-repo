'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

type Window = 'day' | 'week' | 'month';
const WINDOWS: Array<[Window, string]> = [
  ['day', 'Today'], ['week', 'This week'], ['month', 'This month'],
];

interface Item {
  kind: 'meeting' | 'document' | 'minutes';
  id: string; title: string; at: string; participantCount: number; href?: string;
}

function Lane({ heading, items }: { heading: string; items: Item[] }) {
  if (items.length === 0) return null;
  return (
    <section className="mb-8">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/60 mb-3">
        {heading}
      </h2>
      <ul className="flex flex-col gap-1.5">
        {items.map((i) => {
          const meta = (
            <>
              <span className="text-sm truncate">{i.title}</span>
              <span className="text-xs text-muted-foreground/60 shrink-0">
                {new Date(i.at).toLocaleDateString()}
                {i.participantCount > 0 && ` · ${i.participantCount} people`}
              </span>
            </>
          );
          return (
            <li key={`${i.kind}:${i.id}`}>
              {i.href ? (
                <Link href={i.href} className="flex items-baseline justify-between gap-4 py-1.5 hover:text-primary">
                  {meta}
                </Link>
              ) : (
                <div className="flex items-baseline justify-between gap-4 py-1.5">
                  {meta}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function OrgDigest() {
  const [window, setWindow] = useState<Window>('week');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async (w: Window) => {
    setLoading(true);
    setError(false);
    try { setData(await api.org.digest(w)); }
    catch { setError(true); setData(null); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(window); }, [window, load]);

  const empty = data && data.ahead.length === 0 && data.concluded.length === 0;

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="flex items-center gap-1 mb-6">
        {WINDOWS.map(([w, label]) => (
          <button
            key={w}
            onClick={() => setWindow(w)}
            className={`px-3 py-1 text-xs rounded-full transition-colors ${
              w === window ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
        {loading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground/50 ml-2" />}
      </div>

      {!error && data?.narrative && (
        <p className="text-base leading-relaxed mb-8">{data.narrative}</p>
      )}

      {error ? (
        <div className="text-sm text-muted-foreground/70">
          <p className="mb-2">Couldn&apos;t load what&apos;s happening across the institution.</p>
          <button onClick={() => load(window)} className="text-primary hover:underline">
            Try again
          </button>
        </div>
      ) : empty ? (
        <p className="text-sm text-muted-foreground/60">
          Nothing shared yet for this period. Meetings with several people, and documents
          shared with colleagues, will appear here.
        </p>
      ) : (
        <>
          {/* Meetings lead — a deliberate editorial choice, not an accident. */}
          <Lane heading="Ahead" items={data?.ahead ?? []} />
          <Lane heading="Concluded" items={data?.concluded ?? []} />
        </>
      )}
    </div>
  );
}
