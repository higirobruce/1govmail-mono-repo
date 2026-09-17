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
 * its `cid:`. Pairs URIs with `inlineImages` entries in document order, which
 * is the order embedInlineImages wrote them.
 *
 * Idempotent: a body already rewritten contains no data: URIs and is returned
 * untouched, so the job is safe to re-run after an interruption.
 *
 * A URI with no mapping left, or whose cache write fails, is LEFT AS A DATA URI.
 * Rewriting it to a cid with nothing behind it would lose the image outright.
 */
export async function backfillMessage(
  row: Row,
  cache: Pick<InlineImageCacheService, 'write'>,
): Promise<{ html: string; written: number; skipped: number }> {
  const html = row.bodyHtml ?? '';
  const maps = ((row.inlineImages as any[]) ?? []).filter((m) => m?.cid && m?.partId);

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

  // Paged by id so an interruption resumes simply by re-running.
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
