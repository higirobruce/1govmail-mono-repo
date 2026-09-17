import { PrismaClient } from '@prisma/client';
import { InlineImageCacheService, MAX_FILE_BYTES } from './inline-image-cache.service';

interface Row {
  id: string;
  userId: string;
  bodyHtml: string | null;
  inlineImages: unknown;
}

/**
 * Normalise a cid for identity comparison — the same three rules, and for the
 * same reasons, as `rewriteCidRefs` in apps/web/lib/emailRender.ts:
 *
 *  1. Stored cids may be wrapped in angle brackets — Zimbra strips them before
 *     storage, but EWS passes ContentId through raw (ews.service.ts) — while an
 *     HTML `src="cid:…"` reference never has them.
 *  2. HTML may encode the `@` as `&#64;` or `&#x40;`.
 *  3. Case is not significant.
 *
 * Rule 4 lives in `cidBase` below: some mail references only the part before
 * the `@`, so a full-cid miss falls back to that base. It is separate only
 * because the caller has to try both keys, not because it is optional —
 * `rewriteCidRefs` resolves such a reference, so this side must consider the
 * mapping used.
 *
 * Without all of these, an already-converted mapping stored in a different
 * shape than its body reference is missed by the exclusion check below and
 * wrongly re-admitted to the pairing pool.
 *
 * DUPLICATION IS DELIBERATE, AND TEMPORARY. `rewriteCidRefs` is the copy that
 * must stay in step with this one; promoting the pair into packages/shared is
 * deferred to the next release, when rebuilding that package's dist is not a
 * live boot hazard. Change one, change the other — this rule has already
 * drifted once (the missing base fallback was a review finding).
 */
function normalizeCid(cid: string): string {
  return cid
    .replace(/^<|>$/g, '')
    .replace(/&#(?:64|x40);/gi, '@')
    .toLowerCase();
}

/** Rule 3 of the normalisation above: the part of a normalised cid before the `@`. */
function cidBase(normalised: string): string {
  return normalised.split('@')[0];
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
  // Both the full cid and its base go in, and both are checked against, because
  // either side may be the one carrying the `@` suffix. Over-excluding is the
  // safe direction: the worst case is a body left unreclaimed.
  for (let u = cidRe.exec(html); u; u = cidRe.exec(html)) {
    const ref = normalizeCid(u[2]);
    usedCids.add(ref);
    usedCids.add(cidBase(ref));
  }

  const maps = ((row.inlineImages as any[]) ?? [])
    .filter((m) => m?.cid && m?.partId)
    .filter((m) => {
      const cid = normalizeCid(m.cid);
      return !usedCids.has(cid) && !usedCids.has(cidBase(cid));
    });

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

/** The subset of PrismaClient this pass uses, so the walk can be tested without a database. */
export interface BackfillDb {
  $queryRawUnsafe(sql: string): Promise<Array<{ id: string }>>;
  message: {
    findUnique(args: { where: { id: string }; select: Record<string, boolean> }): Promise<any>;
    update(args: { where: { id: string }; data: { bodyHtml: string } }): Promise<any>;
  };
}

/** Ids per page. Ids are ~25 bytes; bodies are up to 133 MB. Only ids are paged. */
const ID_PAGE = 500;

export interface BackfillTotals {
  scanned: number;
  rewritten: number;
  images: number;
  skipped: number;
  ambiguousIds: string[];
}

/**
 * Walk every message that still holds a `data:image` URI and convert what can
 * be converted safely.
 *
 * Pages IDS, not rows, and pulls one body at a time. A page of 50 whole rows
 * would be a gigabyte of JS strings on the box this exists for (648 bodies
 * averaging 20 MB, one of them 133 MB) before the base64 buffers on top — and
 * an OOM there re-selects the same page on the next run, because rows only
 * drop out of the WHERE clause once they have been rewritten. That is a
 * deterministic stall, not a resumable one.
 *
 * Re-running after an interruption is correct for the same reason: the WHERE
 * clause re-selects only rows that still contain a data: URI, so finished rows
 * disappear from every later scan regardless of where the cursor was. The
 * cursor only avoids re-reading rows within one run — and it is what lets the
 * run finish at all when a row is deliberately left unconverted.
 */
export async function runBackfill(
  prisma: BackfillDb,
  cache: Pick<InlineImageCacheService, 'write'>,
  log: (line: string) => void = console.log,
): Promise<BackfillTotals> {
  const totals: BackfillTotals = { scanned: 0, rewritten: 0, images: 0, skipped: 0, ambiguousIds: [] };

  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.$queryRawUnsafe(
      `select id from messages
        where "bodyHtml" like '%data:image%' ${cursor ? `and id > '${cursor}'` : ''}
        order by id limit ${ID_PAGE}`,
    );
    if (page.length === 0) break;

    for (const { id } of page) {
      cursor = id;
      const row = await prisma.message.findUnique({
        where: { id },
        select: { id: true, userId: true, bodyHtml: true, inlineImages: true },
      });
      if (!row) continue;

      totals.scanned++;
      const r = await backfillMessage(row, cache);
      totals.images += r.written;
      totals.skipped += r.skipped + r.skippedAmbiguous;
      if (r.ambiguousBody) totals.ambiguousIds.push(row.id);
      if (r.written > 0) {
        await prisma.message.update({ where: { id: row.id }, data: { bodyHtml: r.html } });
        totals.rewritten++;
      }
    }
    log(`  scanned ${totals.scanned}, rewritten ${totals.rewritten}, images ${totals.images}, skipped ${totals.skipped}`);
  }

  return totals;
}

/** Entry point: `pnpm --filter api backfill:inline-images`. */
export async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const cache = new InlineImageCacheService();

  const totals = await runBackfill(prisma as unknown as BackfillDb, cache);

  console.log(
    `done: ${totals.rewritten}/${totals.scanned} bodies rewritten, ` +
    `${totals.images} images cached, ${totals.skipped} left as data URIs`,
  );
  if (totals.ambiguousIds.length) {
    console.log(
      `${totals.ambiguousIds.length} bodies skipped wholesale — data URIs and mappings did not line up, ` +
      'so converting them could have written one image under another image\'s part id. ' +
      'They keep their base64 and can be reclaimed by hand:',
    );
    for (const id of totals.ambiguousIds) console.log(`  ambiguous: ${id}`);
  }
  console.log('now run:  VACUUM FULL messages;   -- required to return the space to the OS');
  await prisma.$disconnect();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
