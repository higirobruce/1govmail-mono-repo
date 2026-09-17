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

/** Stored cids arrive wrapped in angle brackets; HTML `src="cid:…"` never has them. */
const bareCid = (cid: string) => cid.replace(/^<|>$/g, '');

/**
 * Swap `src="cid:…"` for a resolved URL.
 *
 * Three normalisations, all of them load-bearing and all of them copied from the
 * embed code this replaces (`mail.service.ts:1349-1358`, and see
 * `zimbra.mappers.ts:106`):
 *
 *  1. Stored cids are wrapped in angle brackets — `<img0@govmail>` — while the
 *     HTML reference never is. Both sides are stripped before comparison.
 *  2. HTML may encode the `@` as `&#64;` or `&#x40;`.
 *  3. Some mail references only the part before the `@`, so a full-cid miss
 *     falls back to matching on that base.
 *
 * An unresolved cid is left exactly as it was: a broken image icon is a better
 * failure than a blank src, which some renderers treat as the page itself.
 *
 * `normalizeCid`/`cidBase` in apps/api/src/mail/backfill-inline-images.ts is a
 * deliberate duplicate of these three rules, kept API-local until the shared
 * package can be rebuilt safely. Change one, change the other.
 */
export function rewriteCidRefs(html: string, resolved: Map<string, string>): string {
  if (!html || resolved.size === 0) return html;

  const byCid = new Map<string, string>();
  const byBase = new Map<string, string>();
  for (const [cid, url] of resolved) {
    const bare = bareCid(cid);
    byCid.set(bare.toLowerCase(), url);
    const base = bare.split('@')[0];
    if (base && !byBase.has(base.toLowerCase())) byBase.set(base.toLowerCase(), url);
  }

  return html.replace(
    /src=(["'])cid:([^"']+)\1/gi,
    (whole, quote: string, raw: string) => {
      const ref = bareCid(raw).replace(/&#(?:64|x40);/gi, '@').toLowerCase();
      const url = byCid.get(ref) ?? byBase.get(ref.split('@')[0]);
      return url ? `src=${quote}${url}${quote}` : whole;
    },
  );
}
