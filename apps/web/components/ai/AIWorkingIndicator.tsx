'use client';

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

/** CLI-style working indicator: a pulsing spark, a rotating gerund (or the
 *  exact step when the caller knows it), and elapsed seconds. */
const WORDS = [
  'Thinking', 'Reading', 'Sifting', 'Connecting dots', 'Cross-checking',
  'Weighing options', 'Distilling', 'Drafting', 'Untangling', 'Polishing',
];

export function AIWorkingIndicator({ step, className }: { step?: string; className?: string }) {
  const [word, setWord] = useState(() => WORDS[Math.floor(Math.random() * WORDS.length)]);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const words = setInterval(
      () => setWord((w) => WORDS[(WORDS.indexOf(w) + 1) % WORDS.length]),
      2000,
    );
    const tick = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => { clearInterval(words); clearInterval(tick); };
  }, []);

  return (
    <span className={cn('inline-flex items-baseline gap-1.5 text-ui', className)} role="status">
      <Sparkles className="w-3.5 h-3.5 text-primary animate-pulse self-center shrink-0" />
      <span className="font-medium text-foreground">{step ?? word}…</span>
      {seconds >= 2 && (
        <span className="text-micro font-normal text-ink-4 tabular-nums">({seconds}s)</span>
      )}
    </span>
  );
}
