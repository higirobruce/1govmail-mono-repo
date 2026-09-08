// Session cache of attachment blob object-URLs, keyed `${messageId}:${partId}`.
//
// The lightbox used to revoke + refetch on every prev/next navigation, so
// paging through three attachments downloaded the first one twice, and
// preview-then-download transferred the file two full times. Blob URLs hold
// real memory, so the cache is small (LRU), revokes on eviction, and offers
// per-message revocation for when the reader moves to another message.

const MAX_ENTRIES = 20;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function key(messageId: string, partId: string): string {
  return `${messageId}:${partId}`;
}

/**
 * Cache-first fetch of an attachment's blob URL with in-flight de-duplication.
 * `fetcher` must resolve to an object URL (api.mail.downloadAttachment does).
 */
export function getAttachmentUrl(
  messageId: string,
  partId: string,
  fetcher: () => Promise<string>,
): Promise<string> {
  const k = key(messageId, partId);
  const hit = cache.get(k);
  if (hit !== undefined) {
    // Re-insert to mark most-recently-used.
    cache.delete(k);
    cache.set(k, hit);
    return Promise.resolve(hit);
  }

  const existing = inflight.get(k);
  if (existing) return existing;

  const p = fetcher()
    .then((url) => {
      inflight.delete(k);
      cache.set(k, url);
      while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        const evicted = cache.get(oldest);
        cache.delete(oldest);
        if (evicted) URL.revokeObjectURL(evicted);
      }
      return url;
    })
    .catch((err) => {
      inflight.delete(k);
      throw err;
    });
  inflight.set(k, p);
  return p;
}

/** Revoke and forget every cached blob for one message (reader moved on). */
export function revokeMessageAttachments(messageId: string): void {
  const prefix = `${messageId}:`;
  for (const [k, url] of cache) {
    if (k.startsWith(prefix)) {
      cache.delete(k);
      URL.revokeObjectURL(url);
    }
  }
}

/** Revoke everything — call on logout / auth loss. */
export function clearAttachmentBlobCache(): void {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
  inflight.clear();
}
