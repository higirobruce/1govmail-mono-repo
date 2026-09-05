'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Character-by-character renderer for streamed text.
 *
 * Local LLM SSE streams arrive as token-sized chunks (often whole words),
 * which makes the UI feel "blocky". This hook buffers incoming deltas and
 * drains the buffer one character at a time on a fixed cadence — so the
 * text types out steadily regardless of how the model emits it.
 *
 * Adaptive speed: when the buffer grows large (model is faster than the
 * typer), more chars are released per tick so we don't lag behind at the
 * end of the stream.
 */
export interface UseCharStream {
  text: string;
  push: (delta: string) => void;
  flush: () => void;
  reset: () => void;
  /** Swap the streamed text for a final value (e.g. the scrubbed result). */
  replace: (next: string) => void;
}

const TICK_MS = 15;

export function useCharStream(): UseCharStream {
  const [text, setText] = useState('');
  const queueRef = useRef('');
  const tickerRef = useRef<number | null>(null);

  const stopTicker = useCallback(() => {
    if (tickerRef.current != null) {
      window.clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
  }, []);

  const ensureTicker = useCallback(() => {
    if (tickerRef.current != null) return;
    tickerRef.current = window.setInterval(() => {
      const q = queueRef.current;
      if (q.length === 0) {
        stopTicker();
        return;
      }
      // Adaptive: if the buffer is well ahead, drain faster so we catch up.
      const charsPerTick = Math.max(1, Math.ceil(q.length / 60));
      const slice = q.slice(0, charsPerTick);
      queueRef.current = q.slice(charsPerTick);
      setText((prev) => prev + slice);
    }, TICK_MS);
  }, [stopTicker]);

  const push = useCallback(
    (delta: string) => {
      if (!delta) return;
      queueRef.current += delta;
      ensureTicker();
    },
    [ensureTicker],
  );

  const flush = useCallback(() => {
    stopTicker();
    setText((prev) => prev + queueRef.current);
    queueRef.current = '';
  }, [stopTicker]);

  const reset = useCallback(() => {
    stopTicker();
    queueRef.current = '';
    setText('');
  }, [stopTicker]);

  const replace = useCallback(
    (next: string) => {
      stopTicker();
      queueRef.current = '';
      setText(next);
    },
    [stopTicker],
  );

  useEffect(() => stopTicker, [stopTicker]);

  return { text, push, flush, reset, replace };
}
