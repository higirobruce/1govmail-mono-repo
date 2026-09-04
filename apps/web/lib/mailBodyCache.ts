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
  if (!id || data == null) return;
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

/** Drop everything — call on logout / auth loss. */
export function clearBodyCache(): void {
  cache.clear();
  inflight.clear();
}
