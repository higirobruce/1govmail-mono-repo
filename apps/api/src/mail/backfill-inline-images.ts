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

/**
 * One `src="data:image/…;base64,…"` occurrence, located by hand rather than by
 * regex.
 *
 * ── Why this is not a regular expression ─────────────────────────────────────
 * Measured on 10.10.94.155 (2026-09-18, random sample of 600 of 4,264 rows),
 * the corpus holds three shapes and the obvious regex matches only the first:
 *
 *   1. `src="data:image/png;base64,…"`                        —    81 in sample
 *   2. `src="data:image/gif; name=Odilo.gif;base64,…"`        — the MIME type
 *      carries parameters, so `;base64,` does not follow it directly
 *   3. `src="data:image/gif; name="Paul.gif";base64,…"`       —   792 in sample
 *      the parameter's own quotes close the src attribute early, so as far as
 *      an HTML parser is concerned this image has no source and does not
 *      render. Converting it to a `cid:` reference is what puts it back.
 *
 * Shapes 2 and 3 together are 1,359 of 1,440 — 94% of the corpus. A pattern
 * that spans them needs to cross both commas (filenames contain them) and
 * quotes, which on a 77 MB body is exactly the backtracking that turns a
 * backfill into a hang. Scanning forward from each `data:image/` is linear and
 * cannot backtrack.
 */
interface EmbeddedImage {
  /** Index of the `src` token — the whole attribute is what gets replaced. */
  start: number;
  /** Index just past the attribute's closing quote. */
  end: number;
  /** The quote character the src attribute opened with. */
  quote: string;
  /** Bare MIME type, parameters dropped: `image/gif`. */
  mime: string;
  /** The base64 payload, which may carry line breaks. */
  b64: string;
}

const NEEDLE = 'data:image/';
/** MIME plus its parameters. Generous, but bounded — a real one is under 100. */
const MAX_MIME_SPAN = 512;

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\r' || c === '\n';
const isB64 = (c: string) =>
  (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
  c === '+' || c === '/' || c === '=';

/**
 * Read one embedded image starting at the index of its `data:image/`, or
 * return null when this occurrence is not a well-formed `src` attribute — a
 * data URI in a CSS `url(…)`, an unquoted attribute, a truncated body. Null is
 * always the safe answer: the occurrence is left exactly as it is.
 */
function readEmbeddedImage(html: string, at: number): EmbeddedImage | null {
  // Back up over the opening quote to the `src` token.
  let i = at - 1;
  while (i >= 0 && isSpace(html[i])) i--;
  if (i < 0 || (html[i] !== '"' && html[i] !== "'")) return null;
  const quote = html[i];
  i--;
  while (i >= 0 && isSpace(html[i])) i--;
  if (i < 0 || html[i] !== '=') return null;
  i--;
  while (i >= 0 && isSpace(html[i])) i--;
  if (i < 2 || html.slice(i - 2, i + 1).toLowerCase() !== 'src') return null;
  const start = i - 2;
  // `datasrc=` and friends are not `src=`.
  if (start > 0 && /[A-Za-z0-9_:-]/.test(html[start - 1])) return null;

  // The bare MIME type runs to the first parameter, comma, or quote.
  let j = at + NEEDLE.length;
  while (j < html.length && /[A-Za-z0-9.+-]/.test(html[j])) j++;
  const mime = html.slice(at + 5, j).toLowerCase(); // past "data:"
  if (mime === 'image/') return null;

  // `;base64,` may sit directly after the type or after its parameters.
  const marker = html.indexOf(';base64,', j);
  if (marker === -1 || marker - at > MAX_MIME_SPAN) return null;
  // Never cross out of the tag looking for it.
  const span = html.slice(j, marker);
  if (span.includes('<') || span.includes('>')) return null;

  let k = marker + ';base64,'.length;
  const payloadStart = k;
  while (k < html.length && (isB64(html[k]) || isSpace(html[k]))) k++;
  if (k === payloadStart) return null;
  // Trailing whitespace belongs to the attribute, not the payload.
  let payloadEnd = k;
  while (payloadEnd > payloadStart && isSpace(html[payloadEnd - 1])) payloadEnd--;
  if (html[k] !== quote) return null;

  return { start, end: k + 1, quote, mime, b64: html.slice(payloadStart, payloadEnd) };
}

/** Every embedded image in document order. Overlaps are impossible by construction. */
function findEmbeddedImages(html: string): EmbeddedImage[] {
  const out: EmbeddedImage[] = [];
  for (let i = html.indexOf(NEEDLE); i !== -1; ) {
    const hit = readEmbeddedImage(html, i);
    if (hit) {
      out.push(hit);
      i = html.indexOf(NEEDLE, hit.end);
    } else {
      i = html.indexOf(NEEDLE, i + NEEDLE.length);
    }
  }
  return out;
}

export interface BackfillResult {
  html: string;
  /** Images lifted into the cache and rewritten to their `cid:`. */
  written: number;
  /** Images left as data: URIs, for any reason. Sum of the four below. */
  skipped: number;
  /** Images in a body this pass refused to convert at all — see the guards below. */
  skippedAmbiguous: number;
  /** Images in a body refused because it carries pass 3's `src=""` fingerprint. */
  skippedBlankSrc: number;
  /** Images over InlineImageCacheService's MAX_FILE_BYTES cap. */
  skippedTooLarge: number;
  /** Images the cache declined to store for any other reason (unwritable cache). */
  skippedWriteFailed: number;
  /** True when this whole body was left untouched by any of the three guards. */
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
 * Three guards, all required:
 *  1. BLANK SRC — a body containing an empty `src` attribute is refused
 *     outright. That is pass 3's fingerprint, and it is the ONLY way a mapping
 *     can exist with no data URI beside it in the same body, which is the half
 *     of the desynchronisation the counts cannot see when something else makes
 *     up the difference (see the residual below).
 *  2. COUNTS — the number of unclaimed data: URIs must equal the number of
 *     unclaimed mappings. Catches pass 2, and pass 3 whenever guard 1 has not
 *     already refused the body.
 *  3. MIME — each pair's declared types must match. Catches a re-ordering,
 *     which the counts cannot see. A mapping with no recorded `mimeType` has no
 *     evidence to offer, so it fails this check too.
 * A failure of any of them skips the body WHOLESALE (`ambiguousBody`): once the
 * two sequences are known to disagree, no individual pairing in that body can be
 * trusted either. main() logs those message ids so they can be reclaimed by hand.
 *
 * Why guard 1 exists on top of guard 2 (the case that shipped broken once): a
 * pass-2 extra and a pass-3 blank in the SAME body offset each other. One
 * Zimbra-hosted logo (data URI, no mapping) plus one blanked image (mapping,
 * no data URI) is 1 URI vs 1 mapping — guard 2 passes — and if both declare
 * image/png guard 3 passes too, so the logo's bytes land under the failed
 * image's partId. Guard 1 closes that half deterministically: with it in
 * place, a pass-2 extra can only ever push the URI count ABOVE the mapping
 * count, which guard 2 catches.
 *
 * THE DOCUMENTED REMAINDER, deliberately accepted: a body holding a pass-2
 * extra *and* a mapping that is simply never referenced anywhere in it — not
 * blanked, just absent, so there is no `src=""` to find — with the MIME
 * sequences agreeing. The counts coincide again and nothing left in the body
 * distinguishes it. No evidence available to this pass can separate that from
 * a correctly aligned body, so no amount of further code here closes it. What
 * covers it is that the corruption is recoverable: this database is a cache of
 * Zimbra/Exchange, and `MailService.getMessage` refetches the body from the
 * provider whenever `bodyHtml` or `inlineImages` is null. A row found showing
 * the wrong image is repaired by nulling those two columns and reopening the
 * message — `VACUUM FULL` reclaims only our copy, never the provider's. The
 * exposure is therefore limited to mail deleted server-side since the sync.
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
  const untouched = (count: number, reason: 'ambiguous' | 'blankSrc'): BackfillResult => ({
    html, written: 0,
    skipped: count,
    skippedAmbiguous: reason === 'ambiguous' ? count : 0,
    skippedBlankSrc: reason === 'blankSrc' ? count : 0,
    skippedTooLarge: 0, skippedWriteFailed: 0,
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

  const uris = findEmbeddedImages(html);

  // Guard 1 — pass 3's blank src. Both quote styles, whitespace anywhere a
  // browser would tolerate it, including an all-whitespace value.
  if (/src\s*=\s*(["'])\s*\1/i.test(html)) return untouched(uris.length, 'blankSrc');
  // Guard 2 — counts.
  if (uris.length !== maps.length) return untouched(uris.length, 'ambiguous');
  // Guard 3 — declared MIME types, pair by pair.
  if (uris.some((m, i) => m.mime !== bareMime(maps[i].mimeType) || !bareMime(maps[i].mimeType))) {
    return untouched(uris.length, 'ambiguous');
  }

  let written = 0, skippedTooLarge = 0, skippedWriteFailed = 0;
  const parts: string[] = [];
  let last = 0;

  for (let i = 0; i < uris.length; i++) {
    const m = uris[i];
    const mapping = maps[i];
    const raw = html.slice(m.start, m.end);
    parts.push(html.slice(last, m.start));
    last = m.end;

    const buf = Buffer.from(m.b64, 'base64');
    // Distinguish "too big for the cache" from "the cache would not take it":
    // the first is the heavy tail this backfill exists for, and the run report
    // has to say so before anyone decides whether to raise INLINE_IMAGE_MAX_BYTES.
    if (buf.byteLength > MAX_FILE_BYTES) { parts.push(raw); skippedTooLarge++; continue; }

    const ok = await cache.write(row.userId, row.id, mapping.partId, buf);
    if (!ok) { parts.push(raw); skippedWriteFailed++; continue; }

    parts.push(`src=${m.quote}cid:${mapping.cid}${m.quote}`);
    written++;
  }
  parts.push(html.slice(last));

  return {
    html: parts.join(''),
    written,
    skipped: skippedTooLarge + skippedWriteFailed,
    skippedAmbiguous: 0,
    skippedBlankSrc: 0,
    skippedTooLarge,
    skippedWriteFailed,
    ambiguousBody: false,
  };
}

/** The subset of PrismaClient this pass uses, so the walk can be tested without a database. */
export interface BackfillDb {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<Array<{ id: string }>>;
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
  /** Images left as data: URIs, all reasons. */
  skipped: number;
  /** Over InlineImageCacheService's per-file cap — the heavy tail this pass exists for. */
  skippedTooLarge: number;
  /** The cache refused the write for some other reason (unwritable directory). */
  skippedWriteFailed: number;
  /** Images inside bodies the count/MIME guards refused to touch at all. */
  skippedAmbiguous: number;
  /** Images inside bodies refused for carrying pass 3's `src=""` fingerprint. */
  skippedBlankSrc: number;
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
  const totals: BackfillTotals = {
    scanned: 0, rewritten: 0, images: 0,
    skipped: 0, skippedTooLarge: 0, skippedWriteFailed: 0, skippedAmbiguous: 0,
    skippedBlankSrc: 0,
    ambiguousIds: [],
  };

  let cursor: string | undefined;
  for (;;) {
    // Parameterised, not spliced. The cursor is a cuid read back out of this
    // same table, so it is not attacker-controlled — but this script runs
    // against production, and a raw string splice here is the shape that gets
    // copied into the next script that does take input.
    const page = cursor
      ? await prisma.$queryRaw`select id from messages
          where "bodyHtml" like '%data:image%' and id > ${cursor}
          order by id limit ${ID_PAGE}`
      : await prisma.$queryRaw`select id from messages
          where "bodyHtml" like '%data:image%'
          order by id limit ${ID_PAGE}`;
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
      totals.skipped += r.skipped; // already the sum of the three reasons
      totals.skippedTooLarge += r.skippedTooLarge;
      totals.skippedWriteFailed += r.skippedWriteFailed;
      totals.skippedAmbiguous += r.skippedAmbiguous;
      totals.skippedBlankSrc += r.skippedBlankSrc;
      if (r.ambiguousBody) totals.ambiguousIds.push(row.id);
      if (r.written > 0) {
        await prisma.message.update({ where: { id: row.id }, data: { bodyHtml: r.html } });
        totals.rewritten++;
      }
    }
    log(`  scanned ${totals.scanned}, rewritten ${totals.rewritten}, images ${totals.images}, skipped ${totals.skipped}`);
  }

  reportTotals(totals, log);
  return totals;
}

/**
 * The run summary, split by reason.
 *
 * "skipped: 400" cannot tell anyone whether the heavy tail this pass exists for
 * was reclaimed or refused, and that is precisely the number the decision to
 * raise INLINE_IMAGE_MAX_BYTES for the backfill run turns on. The cap itself is
 * deliberately left alone here: measure the distribution on the live box first,
 * then raise it through the env var for that run if the measurement says so.
 */
function reportTotals(totals: BackfillTotals, log: (line: string) => void): void {
  log(
    `done: ${totals.rewritten}/${totals.scanned} bodies rewritten, ` +
    `${totals.images} images cached, ${totals.skipped} left as data URIs`,
  );
  if (totals.skippedTooLarge) {
    log(
      `  ${totals.skippedTooLarge} over the per-image cap ` +
      `(INLINE_IMAGE_MAX_BYTES=${MAX_FILE_BYTES}) — raise it for the backfill run ` +
      'if the measured size distribution justifies it',
    );
  }
  if (totals.skippedWriteFailed) {
    log(`  ${totals.skippedWriteFailed} refused by the cache — check the cache directory is writable`);
  }
  if (totals.skippedAmbiguous) {
    log(
      `  ${totals.skippedAmbiguous} in bodies skipped wholesale: their data URIs and ` +
      'inlineImages entries did not line up, so converting could have written one ' +
      "image under another image's part id",
    );
  }
  if (totals.skippedBlankSrc) {
    log(
      `  ${totals.skippedBlankSrc} in bodies carrying an empty src="" — an inline ` +
      'image whose download failed at sync time, which leaves a mapping with no ' +
      'data URI beside it and so no trustworthy pairing anywhere in that body',
    );
  }
  if (totals.ambiguousIds.length) {
    log('  the skipped bodies keep their base64 and can be reclaimed by hand:');
    for (const id of totals.ambiguousIds) log(`    ambiguous: ${id}`);
  }
}

/** Entry point: `pnpm --filter api backfill:inline-images`. */
export async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const cache = new InlineImageCacheService();

  await runBackfill(prisma as unknown as BackfillDb, cache);

  console.log('now run:  VACUUM FULL messages;   -- required to return the space to the OS');
  await prisma.$disconnect();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
