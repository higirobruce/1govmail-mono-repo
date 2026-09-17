import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * How long arrivals are allowed to accumulate before they are shown.
 *
 * Long enough that a burst of images lands in one batch; short enough that a
 * reader never notices waiting for it. This is a REPEATING window, not a
 * one-shot delay: it bounds the rebuild RATE at 4/s for as long as images keep
 * arriving. Exported for the tests that pin the flush count.
 */
export const FLUSH_INTERVAL_MS = 250;

/**
 * Resolve a message's inline images to blob: URLs.
 *
 * Returns a NEW Map only when there is something new to show, and at most once
 * per 250 ms window: everything that arrived inside a window is published
 * together, and a final flush publishes the remainder as soon as every request
 * has settled. That bound on the rebuild RATE is the point of this hook's
 * shape.
 *
 * Both readers build the sandboxed iframe's srcDoc from this map, so every new
 * Map identity is a full document reload of the message body: a flicker, a
 * height re-measure, an in-frame scroll reset, and one more multi-megabyte
 * string pushed through the 20-entry `prepareEmailHtml` LRU that the whole app
 * shares — evicting other messages from it. Setting a new Map per resolved
 * image therefore cost an N-image message N reloads, and image-heavy
 * newsletters are exactly this feature's subject.
 *
 * The interval is what keeps it honest in the other direction: one slow or
 * hung image must not hold back the ones that already arrived, which is what
 * waiting for allSettled alone would do. It has to REPEAT for that to hold —
 * a single timer publishes the first window and then leaves every later
 * arrival waiting for the slowest image in the message, which is the shape of
 * a first open after deploy or after an eviction, when every image is a cache
 * miss and the route does a live provider download per part.
 *
 * Every URL created here is revoked on unmount or when the message changes,
 * including one that resolves after the reader has gone. Without that a long
 * mail session leaks every image it has ever rendered.
 */
export function useInlineImages(
  messageId: string | null,
  inlineImages: Array<{ cid: string; partId: string }> | undefined,
): Map<string, string> {
  const [resolved, setResolved] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    // Drop the previous message's urls, but only if there were any: returning
    // the same empty Map lets React bail out instead of spending a render (and
    // in the readers, an iframe rebuild) on every mount.
    setResolved((prev) => (prev.size ? new Map() : prev));
    if (!messageId || !inlineImages?.length) return;

    let alive = true;
    const created: string[] = [];
    // Resolved but not yet shown. Drained by flush(), never read directly.
    const pending = new Map<string, string>();
    let flushTimer: ReturnType<typeof setInterval> | null = null;
    let settled = 0;

    const flush = () => {
      if (!alive || pending.size === 0) return;
      const batch = Array.from(pending);
      pending.clear();
      setResolved((prev) => {
        const next = new Map(prev);
        for (const [cid, url] of batch) next.set(cid, url);
        return next;
      });
    };

    // Repeating, not one-shot: it keeps publishing each window's arrivals for
    // as long as the message still has images in flight. flush() is a no-op
    // when nothing new landed, so an idle interval costs one comparison.
    flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);

    const onSettled = () => {
      if (++settled < inlineImages.length) return;
      // Everything has landed: show the remainder now rather than on the timer,
      // and stop the interval — there is nothing left that could arrive.
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      flush();
    };

    for (const img of inlineImages) {
      api.mail
        .inlineImage(messageId, img.partId)
        .then((url) => {
          if (!alive) { URL.revokeObjectURL(url); return; }
          created.push(url);
          // Key by the cid VERBATIM as stored. rewriteCidRefs does the
          // bracket/entity/base normalisation — doing it in two places would
          // guarantee the two drift apart.
          pending.set(img.cid, url);
        })
        // One image failing is not worth a broken message.
        .catch(() => {})
        .finally(onSettled);
    }

    return () => {
      alive = false;
      if (flushTimer) clearInterval(flushTimer);
      for (const url of created) URL.revokeObjectURL(url);
    };
  }, [messageId, inlineImages]);

  return resolved;
}
