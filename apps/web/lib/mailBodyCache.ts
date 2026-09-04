// Small in-memory LRU of fully-hydrated message bodies, shared across the mail
// UI (the detail pane, the thread messages, and hover-prefetch). Bodies rarely
// change once fetched, so a session-lived cache lets us:
//   • re-open a message instantly (no spinner, no refetch),
//   • skip the duplicate fetch a thread's expanded message would otherwise make
//     for a body the detail pane already downloaded, and
//   • prefetch on hover so the first open feels instant too.
//
// Cleared on logout / 401 (see lib/api.ts) so one user's mail never leaks to the
// next session on a shared device.

const MAX_ENTRIES = 40;
const cache = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();
interface PendingWatch {
  timer: ReturnType<typeof setTimeout>;
  callbacks: Array<(data: never) => void>;
}
const watchers = new Map<string, PendingWatch>();

// While the server is still embedding a message's inline images it returns the
// body flagged `embedPending: true`. Such bodies are display-ready but not
// final — they must never enter the cache, or the embedded version would never
// be fetched.
function isPending(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as { embedPending?: boolean }).embedPending === true;
}

/** Return a cached body (bumping it to most-recently-used) or undefined. */
export function getCachedBody<T = unknown>(id: string): T | undefined {
  if (!id) return undefined;
  const value = cache.get(id);
  if (value === undefined) return undefined;
  // Re-insert to mark most-recently-used.
  cache.delete(id);
  cache.set(id, value);
  return value as T;
}

/** Store a body, evicting the least-recently-used entry past the cap. */
export function setCachedBody(id: string, data: unknown): void {
  if (!id || data == null || isPending(data)) return;
  if (cache.has(id)) cache.delete(id);
  cache.set(id, data);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Cache-first fetch with in-flight de-duplication: concurrent callers for the
 * same id (e.g. a hover-prefetch racing the click that follows it) share one
 * request instead of issuing two.
 */
export function fetchBodyCached<T = unknown>(
  id: string,
  fetcher: (id: string) => Promise<T>,
): Promise<T> {
  const cached = getCachedBody<T>(id);
  if (cached !== undefined) return Promise.resolve(cached);

  const existing = inflight.get(id) as Promise<T> | undefined;
  if (existing) return existing;

  const p = fetcher(id)
    .then((data) => {
      setCachedBody(id, data);
      inflight.delete(id);
      return data;
    })
    .catch((err) => {
      inflight.delete(id);
      throw err;
    });
  inflight.set(id, p);
  return p;
}

const WATCH_INTERVAL_MS = 2_500;
const WATCH_MAX_ATTEMPTS = 8;

/**
 * Poll a message whose body came back `embedPending` until the server has
 * finished embedding its inline images, then cache the final body and hand it
 * to `onFinal` (which the caller uses to swap the rendered body in place).
 *
 * One watcher per id; gives up quietly after WATCH_MAX_ATTEMPTS or on the
 * first network error — the next open simply fetches again.
 */
export function watchPendingBody<T = unknown>(
  id: string,
  fetcher: (id: string) => Promise<T>,
  onFinal: (data: T) => void,
): void {
  if (!id) return;

  // One poll loop per id — additional subscribers (e.g. the thread message row
  // alongside the detail pane) piggyback on the existing loop.
  const existing = watchers.get(id);
  if (existing) {
    existing.callbacks.push(onFinal as (data: never) => void);
    return;
  }

  let attempts = 0;
  const poll = () => {
    const timer = setTimeout(async () => {
      attempts += 1;
      let data: T;
      try {
        data = await fetcher(id);
      } catch {
        watchers.delete(id);
        return;
      }
      // clearBodyCache ran while the fetch was in flight (logout) — drop the result.
      const watch = watchers.get(id);
      if (!watch) return;
      if (isPending(data)) {
        if (attempts >= WATCH_MAX_ATTEMPTS) {
          watchers.delete(id);
        } else {
          poll();
        }
        return;
      }
      watchers.delete(id);
      setCachedBody(id, data);
      for (const cb of watch.callbacks) (cb as (d: T) => void)(data);
    }, WATCH_INTERVAL_MS);
    const watch = watchers.get(id);
    if (watch) {
      watch.timer = timer;
    } else {
      watchers.set(id, { timer, callbacks: [onFinal as (data: never) => void] });
    }
  };
  poll();
}

/** Drop everything — call on logout / auth loss. */
export function clearBodyCache(): void {
  cache.clear();
  inflight.clear();
  for (const watch of watchers.values()) clearTimeout(watch.timer);
  watchers.clear();
}
