import { PrismaClient } from '@prisma/client';
import { InlineImageCacheService, MAX_FILE_BYTES } from './inline-image-cache.service';

interface Row {
  id: string;
  userId: string;
  bodyHtml: string | null;
  inlineImages: unknown;
}

/**
 * Normalise a cid for identity comparison — same three rules, and for the same
 * reason, as `rewriteCidRefs`'s `bareCid`/`@`-decode/lowercase chain in
 * apps/web/lib/emailRender.ts (its browser-side twin: same fix, duplicated on
 * purpose rather than promoted to packages/shared while that package's build
 * is a live hazard — see plan notes):
 *
 *  1. Stored cids may be wrapped in angle brackets — Zimbra strips them before
 *     storage (zimbra.mappers.ts), but EWS passes ContentId through raw
 *     (ews.service.ts) — while an HTML `src="cid:…"` reference never has them.
 *  2. HTML may encode the `@` as `&#64;` or `&#x40;`.
 *  3. Case is not significant.
 *
 * Without this, an already-converted mapping stored in a different shape than
 * its body reference is missed by the exclusion check below and wrongly
 * re-admitted to the pairing pool — the same mis-pairing corruption as an
 * unnormalised re-run, just triggered by ordinary mixed mail instead.
 */
function normalizeCid(cid: string): string {
  return cid
    .replace(/^<|>$/g, '')
    .replace(/&#(?:64|x40);/gi, '@')
    .toLowerCase();
}

/** A MIME type compared for identity: lowercased, parameters (`; name="x"`) dropped. */
function bareMime(mime: unknown): string {
  return typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '';
}

export interface BackfillResult {
  html: string;
  /** Images lifted into the cache and rewritten to their `cid:`. */
  written: number;
  /** Images left as data: URIs, for any reason. Sum of the three below. */
  skipped: number;
  /** Images in a body this pass refused to convert at all — see the guards below. */
  skippedAmbiguous: number;
  /** Images over InlineImageCacheService's MAX_FILE_BYTES cap. */
  skippedTooLarge: number;
  /** Images the cache declined to store for any other reason (unwritable cache). */
  skippedWriteFailed: number;
  /** True when this whole body was left untouched because the evidence was ambiguous. */
  ambiguousBody: boolean;
}

/**
 * Lift every data: URI in one body into the cache and rewrite the tag back to
 * its `cid:`. Pairs each remaining data: URI with the next unclaimed
 * `inlineImages` entry, in document order — the order embedInlineImages wrote
 * them.
 *
 * ── Why the pairing needs guarding at all ────────────────────────────────────
 * Document order and `inlineImages` array order only line up if EVERY data: URI
 * in the body came from cid embedding. At the commit this backfill has to read
 * (8f6d8cc), `embedInlineImages` ran three passes and only the first did that:
 *
 *  - Pass 1 replaced `src="cid:X"` with a data URI  → one URI per mapping.
 *  - Pass 2 (`embedZimbraHostedImages`) base64'd ANY `src` pointing at the
 *    Zimbra host — Briefcase signature logos, `/service/proxy/` images. Those
 *    were never `cid:` references and have NO `inlineImages` entry, so they add
 *    URIs with no mapping, typically ABOVE the real ones (signatures, headers).
 *  - Pass 3 rewrote every still-unresolved cid to `src=""`, so an image whose
 *    download failed leaves a mapping behind with no data URI at all.
 *
 * Either shape shifts the two sequences relative to each other, and a shifted
 * pair writes one image's bytes under another image's partId while relabelling
 * its tag with that other image's cid. Once `VACUUM FULL` has reclaimed the
 * original base64 there is nothing left to repair it from: it is a permanently
 * wrong image, on live government mail. So this pass converts only when the
 * evidence says the sequences are aligned, and otherwise leaves the whole body
 * alone. An unconverted body costs disk; a mis-paired one costs an image.
 *
 * Two guards, both required:
 *  1. COUNTS — the number of unclaimed data: URIs must equal the number of
 *     unclaimed mappings. Catches pass 2 and pass 3.
 *  2. MIME — each pair's declared types must match. Catches a re-ordering,
 *     which the counts cannot see. A mapping with no recorded `mimeType` has no
 *     evidence to offer, so it fails this check too.
 * A failure of either skips the body WHOLESALE (`ambiguousBody`): once the two
 * sequences are known to disagree, no individual pairing in that body can be
 * trusted either. main() logs those message ids so they can be reclaimed by hand.
 *
 * Idempotent: a body already rewritten contains no data: URIs and is returned
 * untouched, so the job is safe to re-run after an interruption.
 *
 * A previous run can leave a body PARTIALLY converted: one image written to
 * the cache and rewritten to its `cid:`, a sibling skipped (e.g. over
 * InlineImageCacheService's MAX_FILE_BYTES cap) and still a data: URI — and
 * that body is persisted regardless, since main() writes back whenever
 * anything in it converted. On the next run only the skipped image's data:
 * URI remains, so mappings whose (normalised) `cid` already appears as a
 * (normalised) `cid:` reference in the body are excluded from the pairing
 * pool up front. Without this, a positional index reset to 0 on every call
 * would pair the remaining URI with the WRONG mapping — overwriting the
 * already-converted image's cache file with the wrong bytes and relabelling
 * it with the wrong cid. The same corruption is also reachable in a single
 * call, not just across runs, when a genuine pre-existing `cid:` reference
 * sits beside a base64'd image — see `normalizeCid` above.
 *
 * A URI whose cache write fails is LEFT AS A DATA URI. Rewriting it to a cid
 * with nothing behind it would lose the image outright.
 *
 * Known deferred minor: if two mappings share a cid, both are excluded once
 * either is referenced, so an unconverted sibling can never be reclaimed. It
 * stays a data: URI — a lost opportunity, not a bug.
 */
export async function backfillMessage(
  row: Row,
  cache: Pick<InlineImageCacheService, 'write'>,
): Promise<BackfillResult> {
  const html = row.bodyHtml ?? '';
  const untouched = (count: number): BackfillResult => ({
    html, written: 0,
    skipped: count, skippedAmbiguous: count, skippedTooLarge: 0, skippedWriteFailed: 0,
    ambiguousBody: count > 0,
  });

  // A mapping already referenced by a `cid:` tag in the body has already been
  // converted by an earlier run — it is not part of the pool being paired here.
  const usedCids = new Set<string>();
  const cidRe = /src=(["'])cid:([^"']+)\1/gi;
  for (let u = cidRe.exec(html); u; u = cidRe.exec(html)) usedCids.add(normalizeCid(u[2]));

  const maps = ((row.inlineImages as any[]) ?? [])
    .filter((m) => m?.cid && m?.partId)
    .filter((m) => !usedCids.has(normalizeCid(m.cid)));

  const re = /src=(["'])data:(image\/[^;]+);base64,([^"']+)\1/gi;
  const uris = Array.from(html.matchAll(re));

  // Guard 1 — counts.
  if (uris.length !== maps.length) return untouched(uris.length);
  // Guard 2 — declared MIME types, pair by pair.
  if (uris.some((m, i) => bareMime(m[2]) !== bareMime(maps[i].mimeType) || !bareMime(maps[i].mimeType))) {
    return untouched(uris.length);
  }

  let written = 0, skippedTooLarge = 0, skippedWriteFailed = 0;
  const parts: string[] = [];
  let last = 0;

  for (let i = 0; i < uris.length; i++) {
    const m = uris[i];
    const mapping = maps[i];
    const at = m.index ?? 0;
    parts.push(html.slice(last, at));
    last = at + m[0].length;

    const buf = Buffer.from(m[3], 'base64');
    // Distinguish "too big for the cache" from "the cache would not take it":
    // the first is the heavy tail this backfill exists for, and the run report
    // has to say so before anyone decides whether to raise INLINE_IMAGE_MAX_BYTES.
    if (buf.byteLength > MAX_FILE_BYTES) { parts.push(m[0]); skippedTooLarge++; continue; }

    const ok = await cache.write(row.userId, row.id, mapping.partId, buf);
    if (!ok) { parts.push(m[0]); skippedWriteFailed++; continue; }

    parts.push(`src=${m[1]}cid:${mapping.cid}${m[1]}`);
    written++;
  }
  parts.push(html.slice(last));

  return {
    html: parts.join(''),
    written,
    skipped: skippedTooLarge + skippedWriteFailed,
    skippedAmbiguous: 0,
    skippedTooLarge,
    skippedWriteFailed,
    ambiguousBody: false,
  };
}

/** Entry point: `pnpm --filter api backfill:inline-images`. */
export async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const cache = new InlineImageCacheService();
  let scanned = 0, rewritten = 0, images = 0, skipped = 0;
  // Bodies the pairing guards refused to touch. They are listed, not just
  // counted: each one still holds its base64 and can be reclaimed by hand, and
  // a human needs the ids to do that. A body here is intact, never corrupted.
  const ambiguousIds: string[] = [];

  // Paged by id, 50 at a time. What actually makes a re-run after an
  // interruption correct is the WHERE clause below: it re-selects only rows
  // that still contain a data: URI, so already-finished rows drop out of
  // every subsequent scan regardless of where the in-memory cursor was when
  // the process stopped. The cursor only avoids re-reading rows within one run.
  let cursor: string | undefined;
  for (;;) {
    const rows: Row[] = await prisma.$queryRawUnsafe(
      `select id, "userId", "bodyHtml", "inlineImages" from messages
        where "bodyHtml" like '%data:image%' ${cursor ? `and id > '${cursor}'` : ''}
        order by id limit 50`,
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned++;
      const r = await backfillMessage(row, cache);
      images += r.written; skipped += r.skipped + r.skippedAmbiguous;
      if (r.ambiguousBody) ambiguousIds.push(row.id);
      if (r.written > 0) {
        await prisma.message.update({ where: { id: row.id }, data: { bodyHtml: r.html } });
        rewritten++;
      }
      cursor = row.id;
    }
    console.log(`  scanned ${scanned}, rewritten ${rewritten}, images ${images}, skipped ${skipped}`);
  }

  console.log(`done: ${rewritten}/${scanned} bodies rewritten, ${images} images cached, ${skipped} left as data URIs`);
  if (ambiguousIds.length) {
    console.log(
      `${ambiguousIds.length} bodies skipped wholesale — data URIs and mappings did not line up, ` +
      'so converting them could have written one image under another image\'s part id. ' +
      'They keep their base64 and can be reclaimed by hand:',
    );
    for (const id of ambiguousIds) console.log(`  ambiguous: ${id}`);
  }
  console.log('now run:  VACUUM FULL messages;   -- required to return the space to the OS');
  await prisma.$disconnect();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
