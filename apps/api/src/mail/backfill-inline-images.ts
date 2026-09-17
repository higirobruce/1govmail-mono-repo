import { PrismaClient } from '@prisma/client';
import { InlineImageCacheService } from './inline-image-cache.service';

interface Row {
  id: string;
  userId: string;
  bodyHtml: string | null;
  inlineImages: unknown;
}

/**
 * Lift every data: URI in one body into the cache and rewrite the tag back to
 * its `cid:`. Pairs each remaining data: URI with the next unclaimed
 * `inlineImages` entry, in document order — the order embedInlineImages wrote
 * them.
 *
 * Idempotent: a body already rewritten contains no data: URIs and is returned
 * untouched, so the job is safe to re-run after an interruption.
 *
 * A previous run can leave a body PARTIALLY converted: one image written to
 * the cache and rewritten to its `cid:`, a sibling skipped (e.g. over
 * InlineImageCacheService's MAX_FILE_BYTES cap) and still a data: URI — and
 * that body is persisted regardless, since main() writes back whenever
 * anything in it converted. On the next run only the skipped image's data:
 * URI remains, so mappings whose `cid` already appears as a `cid:` reference
 * in the body are excluded from the pairing pool up front. Without this, a
 * positional index reset to 0 on every call would pair the remaining URI with
 * the WRONG mapping — overwriting the already-converted image's cache file
 * with the wrong bytes and relabelling it with the wrong cid.
 *
 * A URI with no mapping left, or whose cache write fails, is LEFT AS A DATA URI.
 * Rewriting it to a cid with nothing behind it would lose the image outright.
 */
export async function backfillMessage(
  row: Row,
  cache: Pick<InlineImageCacheService, 'write'>,
): Promise<{ html: string; written: number; skipped: number }> {
  const html = row.bodyHtml ?? '';

  // A mapping already referenced by a `cid:` tag in the body has already been
  // converted by an earlier run — it is not part of the pool being paired here.
  const usedCids = new Set<string>();
  const cidRe = /src=(["'])cid:([^"']+)\1/gi;
  for (let u = cidRe.exec(html); u; u = cidRe.exec(html)) usedCids.add(u[2]);

  const maps = ((row.inlineImages as any[]) ?? [])
    .filter((m) => m?.cid && m?.partId)
    .filter((m) => !usedCids.has(m.cid));

  let written = 0, skipped = 0, index = 0;
  const parts: string[] = [];
  let last = 0;

  const re = /src=(["'])data:(image\/[^;]+);base64,([^"']+)\1/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const mapping = maps[index++];
    parts.push(html.slice(last, m.index));
    last = m.index + m[0].length;

    if (!mapping) { parts.push(m[0]); skipped++; continue; }

    const buf = Buffer.from(m[3], 'base64');
    const ok = await cache.write(row.userId, row.id, mapping.partId, buf);
    if (!ok) { parts.push(m[0]); skipped++; continue; }

    parts.push(`src=${m[1]}cid:${mapping.cid}${m[1]}`);
    written++;
  }
  parts.push(html.slice(last));

  return { html: parts.join(''), written, skipped };
}

/** Entry point: `pnpm --filter api backfill:inline-images`. */
export async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const cache = new InlineImageCacheService();
  let scanned = 0, rewritten = 0, images = 0, skipped = 0;

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
      images += r.written; skipped += r.skipped;
      if (r.written > 0) {
        await prisma.message.update({ where: { id: row.id }, data: { bodyHtml: r.html } });
        rewritten++;
      }
      cursor = row.id;
    }
    console.log(`  scanned ${scanned}, rewritten ${rewritten}, images ${images}, skipped ${skipped}`);
  }

  console.log(`done: ${rewritten}/${scanned} bodies rewritten, ${images} images cached, ${skipped} left as data URIs`);
  console.log('now run:  VACUUM FULL messages;   -- required to return the space to the OS');
  await prisma.$disconnect();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
