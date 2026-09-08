// Shared email-body preparation for the reader surfaces (MailDetail and
// ThreadMessage). Preparing a body is expensive — DOMPurify plus regex passes
// over HTML that can hold multi-megabyte base64 images — and the readers
// re-render on every iframe height change, so results are memoized per input
// string. The small LRU also survives remounts (message switch remounts the
// reader via key=), making back-and-forth between two messages free.

import { sanitizeEmailHtml } from './sanitize';

const CACHE_CAP = 20;

/** Return the inner content of an HTML document's body, or the fragment as-is. */
export function extractBodyContent(html: string): string {
  const match = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (match) return match[1];
  return html
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<\/?(html|body)[^>]*>/gi, '')
    .trim();
}

/**
 * Build a memoized preparer: Zimbra `dfsrc` → `src` (deferred images), strip
 * the non-standard `name=` parameter from data URIs (its unescaped quotes
 * break attribute parsing), unwrap the document, then sanitize.
 * The sanitizer is injectable for tests; production uses sanitizeEmailHtml.
 */
export function createEmailPreparer(
  sanitize: (html: string) => string = sanitizeEmailHtml,
): (html: string) => string {
  const cache = new Map<string, string>();
  return (html: string): string => {
    const hit = cache.get(html);
    if (hit !== undefined) {
      // Re-insert to mark most-recently-used.
      cache.delete(html);
      cache.set(html, hit);
      return hit;
    }
    const prepared = sanitize(
      extractBodyContent(html)
        .replace(/\bdfsrc=/gi, 'src=')
        .replace(/data:([^;]+);\s*name="[^"]*";/gi, 'data:$1;'),
    );
    cache.set(html, prepared);
    while (cache.size > CACHE_CAP) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return prepared;
  };
}

/** App-wide memoized preparer shared by all reader components. */
export const prepareEmailHtml = createEmailPreparer();
