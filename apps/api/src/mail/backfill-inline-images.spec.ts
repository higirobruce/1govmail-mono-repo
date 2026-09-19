import { backfillMessage, runBackfill } from './backfill-inline-images';
import { MAX_FILE_BYTES } from './inline-image-cache.service';

const cache = () => ({ write: jest.fn().mockResolvedValue(true) } as any);

const PNG = Buffer.from('fakepng').toString('base64');

describe('backfillMessage', () => {
  it('lifts a data uri into the cache and rewrites the tag to its cid', async () => {
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/png;base64,${PNG}">`,
      inlineImages: [{ cid: 'c1', partId: '1.1.2', mimeType: 'image/png' }],
    };

    const r = await backfillMessage(row as any, c);

    expect(r.html).toBe('<img src="cid:c1">');
    expect(r.written).toBe(1);
    expect(c.write).toHaveBeenCalledWith('u1', 'm1', '1.1.2', expect.any(Buffer));
    expect((c.write.mock.calls[0][3] as Buffer).toString()).toBe('fakepng');
  });

  it('pairs data uris with inlineImages entries in order', async () => {
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/png;base64,${PNG}"><img src="data:image/gif;base64,${PNG}">`,
      inlineImages: [
        { cid: 'c1', partId: '1.1', mimeType: 'image/png' },
        { cid: 'c2', partId: '1.2', mimeType: 'image/gif' },
      ],
    };

    const r = await backfillMessage(row as any, c);

    expect(r.html).toBe('<img src="cid:c1"><img src="cid:c2">');
    expect(c.write.mock.calls.map((x: any[]) => x[2])).toEqual(['1.1', '1.2']);
  });

  it('leaves a data uri alone when there is no mapping left for it', async () => {
    // Safety valve: rewriting to a cid with nothing behind it would lose the image.
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/png;base64,${PNG}">`,
      inlineImages: [],
    };

    const r = await backfillMessage(row as any, c);

    expect(r.html).toContain('data:image/png;base64');
    expect(r.written).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('leaves the tag as a data uri when the cache write fails', async () => {
    const c = cache();
    c.write.mockResolvedValue(false);
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/png;base64,${PNG}">`,
      inlineImages: [{ cid: 'c1', partId: '1.1', mimeType: 'image/png' }],
    };

    const r = await backfillMessage(row as any, c);

    expect(r.html).toContain('data:image/png;base64');
    expect(r.skipped).toBe(1);
  });

  it('is idempotent — a body already rewritten is left untouched', async () => {
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: '<img src="cid:c1">',
      inlineImages: [{ cid: 'c1', partId: '1.1', mimeType: 'image/png' }],
    };

    const r = await backfillMessage(row as any, c);

    expect(r.html).toBe('<img src="cid:c1">');
    expect(r.written).toBe(0);
    expect(c.write).not.toHaveBeenCalled();
  });

  it('on a second run, does not reuse a mapping already spoken for by a converted image', async () => {
    // Reproduces a partial state a real first run leaves behind: image A is
    // under the cache cap and converts; image B is over it (Task 1's
    // MAX_FILE_BYTES) and cache.write reports false, so it stays a data: URI.
    // main() persists this body anyway because `written > 0`.
    const c = cache();
    c.write.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/png;base64,${PNG}"><img src="data:image/gif;base64,${PNG}">`,
      inlineImages: [
        { cid: 'a', partId: '1.1', mimeType: 'image/png' },
        { cid: 'b', partId: '1.2', mimeType: 'image/gif' },
      ],
    };

    const first = await backfillMessage(row as any, c);
    expect(first.html).toBe(`<img src="cid:a"><img src="data:image/gif;base64,${PNG}">`);

    // Re-run against the persisted, partially-converted body — exactly what
    // a second invocation of the command sees for this row.
    c.write.mockClear();
    const second = await backfillMessage({ ...row, bodyHtml: first.html } as any, c);

    // The one remaining data: URI is image B. It must be paired with B's own
    // mapping (partId 1.2) — never with A's, which would overwrite A's
    // already-correct cache file with B's bytes and relabel B's tag as A.
    expect(second.html).toBe('<img src="cid:a"><img src="cid:b">');
    expect(c.write).toHaveBeenCalledTimes(1);
    expect(c.write).toHaveBeenCalledWith('u1', 'm1', '1.2', expect.any(Buffer));
  });

  // The same mis-pairing corruption as the "second run" test above, but
  // triggered in a single call by a format mismatch instead of a prior run —
  // an "already referenced" cid can arrive in a different shape than the one
  // stored on inlineImages, because different providers write cid differently
  // (Zimbra strips angle brackets before storage; EWS passes ContentId through
  // raw with brackets intact). Without normalising both sides identically,
  // the exclusion check misses and the mapping is wrongly re-admitted to the
  // pairing pool.

  it('excludes an already-referenced mapping even when its stored cid is bracketed (the EWS shape) but the body reference is not', async () => {
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="cid:img0@host"><img src="data:image/gif;base64,${PNG}">`,
      inlineImages: [
        { cid: '<img0@host>', partId: '1.1', mimeType: 'image/png' },
        { cid: 'img1@host', partId: '1.2', mimeType: 'image/gif' },
      ],
    };

    const r = await backfillMessage(row as any, c);

    expect(c.write).toHaveBeenCalledTimes(1);
    expect(c.write).toHaveBeenCalledWith('u1', 'm1', '1.2', expect.any(Buffer));
    expect(r.html).toBe('<img src="cid:img0@host"><img src="cid:img1@host">');
  });

  it('excludes an already-referenced mapping when only letter case differs between the stored cid and the body reference', async () => {
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="cid:IMG0@HOST"><img src="data:image/gif;base64,${PNG}">`,
      inlineImages: [
        { cid: 'img0@host', partId: '1.1', mimeType: 'image/png' },
        { cid: 'img1@host', partId: '1.2', mimeType: 'image/gif' },
      ],
    };

    const r = await backfillMessage(row as any, c);

    expect(c.write).toHaveBeenCalledTimes(1);
    expect(c.write).toHaveBeenCalledWith('u1', 'm1', '1.2', expect.any(Buffer));
    expect(r.html).toBe('<img src="cid:IMG0@HOST"><img src="cid:img1@host">');
  });

  it('excludes an already-referenced mapping when the body HTML-encodes the @ as &#64;', async () => {
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="cid:img0&#64;host"><img src="data:image/gif;base64,${PNG}">`,
      inlineImages: [
        { cid: 'img0@host', partId: '1.1', mimeType: 'image/png' },
        { cid: 'img1@host', partId: '1.2', mimeType: 'image/gif' },
      ],
    };

    const r = await backfillMessage(row as any, c);

    expect(c.write).toHaveBeenCalledTimes(1);
    expect(c.write).toHaveBeenCalledWith('u1', 'm1', '1.2', expect.any(Buffer));
    expect(r.html).toBe('<img src="cid:img0&#64;host"><img src="cid:img1@host">');
  });

  // ── C1: the two ambiguity guards ─────────────────────────────────────────
  // At the pre-branch commit, `embedInlineImages` ran three passes and only the
  // first produced cid-derived data URIs. Pass 2 (embedZimbraHostedImages) also
  // base64'd any Zimbra-hosted `src` — Briefcase signature logos, /service/proxy/
  // images — and those have NO inlineImages entry at all. Pass 3 blanked cids
  // whose download failed, leaving a mapping with no data URI. Either shape
  // desynchronises "data URIs in document order" from "mappings in array order",
  // and the resulting write puts one image's bytes under another's partId —
  // permanently, once VACUUM FULL has reclaimed the original base64.

  it('converts nothing when a body holds more data URIs than mappings (the Briefcase-logo shape)', async () => {
    // The exact corrupting case: a Zimbra-hosted signature logo (pass 2, no
    // mapping) sits ABOVE the one genuine cid image (pass 1, mapping 1.2).
    // Positional pairing hands the logo's bytes to the real image's partId.
    const c = cache();
    const LOGO = Buffer.from('briefcase-logo').toString('base64');
    const REAL = Buffer.from('the-real-inline-image').toString('base64');
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/jpeg;base64,${LOGO}"><img src="data:image/png;base64,${REAL}">`,
      inlineImages: [{ cid: 'real@host', partId: '1.2', mimeType: 'image/png' }],
    };

    const r = await backfillMessage(row as any, c);

    expect(c.write).not.toHaveBeenCalled();
    expect(r.html).toBe(row.bodyHtml);
    expect(r.written).toBe(0);
    expect(r.ambiguousBody).toBe(true);
    expect(r.skippedAmbiguous).toBe(2);
  });

  it('converts nothing when a body holds fewer data URIs than mappings (pass 3 blanked one)', async () => {
    // An image whose download failed was rewritten to src="" by pass 3, so its
    // mapping survives in inlineImages with no data URI behind it. Pairing in
    // array order then shifts every later image by one.
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src=""><img src="data:image/gif;base64,${PNG}">`,
      inlineImages: [
        { cid: 'failed@host', partId: '1.1', mimeType: 'image/png' },
        { cid: 'ok@host', partId: '1.2', mimeType: 'image/gif' },
      ],
    };

    const r = await backfillMessage(row as any, c);

    expect(c.write).not.toHaveBeenCalled();
    expect(r.html).toBe(row.bodyHtml);
    expect(r.ambiguousBody).toBe(true);
  });

  it('converts nothing when a pass-2 extra and a pass-3 blank offset each other', async () => {
    // The coincidence neither the count nor the MIME guard can see: one
    // Zimbra-hosted logo (data URI, NO mapping) beside one image whose download
    // failed (mapping survives, src="" and no data URI). 1 URI == 1 mapping and
    // both are image/png, so positional pairing would write the LOGO's bytes
    // under the failed image's partId and relabel the logo's tag with the
    // failed image's cid. The empty src is the only evidence left that the two
    // sequences disagree — it is the one shape that can hide a missing URI.
    const c = cache();
    const LOGO = Buffer.from('briefcase-logo').toString('base64');
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/png;base64,${LOGO}"><img src="">`,
      inlineImages: [{ cid: 'failed@host', partId: '1.2', mimeType: 'image/png' }],
    };

    const r = await backfillMessage(row as any, c);

    expect(c.write).not.toHaveBeenCalled();
    expect(r.html).toBe(row.bodyHtml);
    expect(r.written).toBe(0);
    expect(r.ambiguousBody).toBe(true);
    expect(r.skippedBlankSrc).toBe(1);
    expect(r.skippedAmbiguous).toBe(0);
  });

  it.each([
    ["single quotes", "<img src=''>"],
    ["spaces around the =", '<img src = "">'],
    ["whitespace for a value", '<img src=" ">'],
  ])('recognises pass 3\'s blank src written with %s', async (_label, blank) => {
    const c = cache();
    const LOGO = Buffer.from('briefcase-logo').toString('base64');
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/png;base64,${LOGO}">${blank}`,
      inlineImages: [{ cid: 'failed@host', partId: '1.2', mimeType: 'image/png' }],
    };

    const r = await backfillMessage(row as any, c);

    expect(c.write).not.toHaveBeenCalled();
    expect(r.html).toBe(row.bodyHtml);
    expect(r.skippedBlankSrc).toBe(1);
  });

  it('converts nothing when the counts agree but a declared MIME type does not match its pair', async () => {
    // Counts alone cannot catch a re-ordering: two images, two mappings, but
    // document order is gif-then-png while the MIME part order is png-then-gif.
    // The MIME check is the only evidence left that the sequences disagree.
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/gif;base64,${PNG}"><img src="data:image/png;base64,${PNG}">`,
      inlineImages: [
        { cid: 'a@host', partId: '1.1', mimeType: 'image/png' },
        { cid: 'b@host', partId: '1.2', mimeType: 'image/gif' },
      ],
    };

    const r = await backfillMessage(row as any, c);

    expect(c.write).not.toHaveBeenCalled();
    expect(r.html).toBe(row.bodyHtml);
    expect(r.ambiguousBody).toBe(true);
  });

  it('compares MIME types case-insensitively and ignores parameters', async () => {
    // `image/PNG` from the provider's Content-Type header and `image/png` on
    // the mapping are the same type; refusing that pair would strand a body
    // for no reason.
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/PNG;base64,${PNG}">`,
      inlineImages: [{ cid: 'a@host', partId: '1.1', mimeType: 'image/png; name="x.png"' }],
    };

    const r = await backfillMessage(row as any, c);

    expect(r.html).toBe('<img src="cid:a@host">');
    expect(r.written).toBe(1);
    expect(r.ambiguousBody).toBe(false);
  });

  it('converts nothing when a mapping carries no MIME type to check against', async () => {
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/png;base64,${PNG}">`,
      inlineImages: [{ cid: 'a@host', partId: '1.1' }],
    };

    const r = await backfillMessage(row as any, c);

    expect(c.write).not.toHaveBeenCalled();
    expect(r.ambiguousBody).toBe(true);
  });

  // ── C9: rule 3, the base-before-@ fallback ───────────────────────────────
  // `rewriteCidRefs` (apps/web/lib/emailRender.ts) resolves a reference by the
  // part before the `@` when the full cid misses, because real Outlook mail
  // references images that way. The exclusion check here has to use the same
  // three rules, or a mapping that IS already referenced looks unreferenced,
  // re-enters the pairing pool, and unbalances the counts.

  it('excludes an already-referenced mapping when the body references only the part before the @', async () => {
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="cid:image001.gif"><img src="data:image/gif;base64,${PNG}">`,
      inlineImages: [
        { cid: 'image001.gif@01DD2986.DAAA8E30', partId: '1.1', mimeType: 'image/png' },
        { cid: 'other@host', partId: '1.2', mimeType: 'image/gif' },
      ],
    };

    const r = await backfillMessage(row as any, c);

    expect(c.write).toHaveBeenCalledTimes(1);
    expect(c.write).toHaveBeenCalledWith('u1', 'm1', '1.2', expect.any(Buffer));
    expect(r.html).toBe('<img src="cid:image001.gif"><img src="cid:other@host">');
  });

  it('excludes an already-referenced mapping when the mapping stores only the part before the @', async () => {
    // The mirror image: rewriteCidRefs indexes the resolved map by base too, so
    // this reference also resolves in the browser and must be treated as used.
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="cid:image001.gif@01DD2986.DAAA8E30"><img src="data:image/gif;base64,${PNG}">`,
      inlineImages: [
        { cid: 'image001.gif', partId: '1.1', mimeType: 'image/png' },
        { cid: 'other@host', partId: '1.2', mimeType: 'image/gif' },
      ],
    };

    const r = await backfillMessage(row as any, c);

    expect(c.write).toHaveBeenCalledTimes(1);
    expect(c.write).toHaveBeenCalledWith('u1', 'm1', '1.2', expect.any(Buffer));
  });
});

// ── C2/C6: how main() walks the table ───────────────────────────────────────
// The body column is the whole problem this backfill exists for: on .155, 648
// bodies average 20 MB and one is 133 MB. A page of 50 whole rows is therefore
// a gigabyte of JS strings before the base64 buffers, and an OOM re-selects the
// SAME page next run — a deterministic stall, not a resumable one. So the pass
// pages IDS, and pulls one body at a time.

interface FakeRow { id: string; userId: string; bodyHtml: string; inlineImages: any }

function fakeDb(rows: FakeRow[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const state = {
    idQueries: [] as Array<{ sql: string; values: unknown[] }>,
    bodyFetches: [] as string[],
    updates: [] as Array<{ id: string; bodyHtml: string }>,
    peakBodiesInFlight: 0,
    inFlight: 0,
  };

  const page = (cursor: string | undefined, take: number) =>
    rows
      .map((r) => r.id)
      .sort()
      .filter((id) => (cursor ? id > cursor : true))
      .slice(0, take)
      .map((id) => ({ id }));

  const db = {
    state,
    // The parameterised form (C6).
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      state.idQueries.push({ sql, values });
      const cursor = values.find((v) => typeof v === 'string') as string | undefined;
      const take = (values.find((v) => typeof v === 'number') as number | undefined) ?? 500;
      return page(cursor, take);
    },
    // The spliced form, so this fake works either side of the C6 change.
    $queryRawUnsafe: async (sql: string) => {
      state.idQueries.push({ sql, values: [] });
      const cursor = /id > '([^']+)'/.exec(sql)?.[1];
      const take = Number(/limit (\d+)/.exec(sql)?.[1] ?? 500);
      return page(cursor, take);
    },
    message: {
      findUnique: async ({ where }: any) => {
        state.bodyFetches.push(where.id);
        state.inFlight++;
        // A real suspension point, and the reason this fake is async at all.
        // Without one, inFlight is back to 0 before the function ever yields
        // and peakBodiesInFlight cannot exceed 1 under ANY implementation —
        // including `Promise.all(page.map(findUnique))`, which is the one
        // shape this assertion exists to catch (and which bodyFetches, being
        // order-preserving, does not catch on its own).
        await new Promise((r) => setImmediate(r));
        state.peakBodiesInFlight = Math.max(state.peakBodiesInFlight, state.inFlight);
        const row = byId.get(where.id) ?? null;
        state.inFlight--;
        return row;
      },
      update: async ({ where, data }: any) => {
        state.updates.push({ id: where.id, bodyHtml: data.bodyHtml });
        byId.get(where.id)!.bodyHtml = data.bodyHtml;
      },
    },
  };
  return db;
}

const convertible = (id: string): FakeRow => ({
  id, userId: 'u1',
  bodyHtml: `<img src="data:image/png;base64,${PNG}">`,
  inlineImages: [{ cid: `${id}@host`, partId: '1.1', mimeType: 'image/png' }],
});

describe('runBackfill', () => {
  it('pages ids only — the body column never appears in the page query', async () => {
    const db = fakeDb([convertible('m1'), convertible('m2')]);

    await runBackfill(db as any, cache(), () => {});

    expect(db.state.idQueries.length).toBeGreaterThan(0);
    for (const q of db.state.idQueries) {
      expect(q.sql).toMatch(/select\s+id\s+from\s+messages/i);
      // `"bodyHtml" like` in the WHERE is fine; selecting it is not.
      expect(q.sql).not.toMatch(/select[\s\S]*"bodyHtml"[\s\S]*from/i);
    }
  });

  it('fetches one body at a time, never a page of them', async () => {
    const db = fakeDb([convertible('m1'), convertible('m2'), convertible('m3')]);

    await runBackfill(db as any, cache(), () => {});

    expect(db.state.bodyFetches).toEqual(['m1', 'm2', 'm3']);
    expect(db.state.peakBodiesInFlight).toBe(1);
  });

  it('converts every row and writes each rewritten body back', async () => {
    const db = fakeDb([convertible('m1'), convertible('m2')]);

    const totals = await runBackfill(db as any, cache(), () => {});

    expect(totals.scanned).toBe(2);
    expect(totals.rewritten).toBe(2);
    expect(totals.images).toBe(2);
    expect(db.state.updates.map((u) => u.bodyHtml)).toEqual([
      '<img src="cid:m1@host">',
      '<img src="cid:m2@host">',
    ]);
  });

  it('advances past a row it did not rewrite instead of looping on it', async () => {
    // An ambiguous body is never updated, so it still matches the WHERE clause.
    // Only the cursor moves it out of the way — without that the run never ends.
    const ambiguous: FakeRow = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/png;base64,${PNG}">`,
      inlineImages: [],
    };
    const db = fakeDb([ambiguous, convertible('m2')]);

    const totals = await runBackfill(db as any, cache(), () => {});

    expect(totals.scanned).toBe(2);
    expect(totals.rewritten).toBe(1);
    expect(db.state.updates.map((u) => u.id)).toEqual(['m2']);
  });

  it('passes the paging cursor as a query parameter, never spliced into the SQL', async () => {
    // A DB-sourced cuid is not attacker-controlled today, but this script runs
    // against production and the shape is what gets copied next time.
    const db = fakeDb([convertible('m1'), convertible('m2')]);

    await runBackfill(db as any, cache(), () => {});

    const cursored = db.state.idQueries.filter((q) => q.values.some((v) => v === 'm2'));
    expect(cursored.length).toBeGreaterThan(0);
    for (const q of db.state.idQueries) {
      expect(q.sql).not.toContain("'m2'");
      expect(q.sql).not.toContain('m2');
    }
  });

  // ── C3: the run report has to say WHY an image was left behind ───────────
  // The whole point of this backfill is the heavy tail — 648 bodies holding
  // 13 GB, one image of 133 MB — which is exactly where a single image is most
  // likely to exceed the 5 MB per-file cap. "skipped: 400" cannot tell anyone
  // whether the tail was reclaimed or refused, and that is the one number the
  // decision to raise INLINE_IMAGE_MAX_BYTES for the run depends on.

  it('counts and reports skipped images by reason', async () => {
    const over = Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64');
    const rows: FakeRow[] = [
      { id: 'm1', userId: 'u1',
        bodyHtml: `<img src="data:image/png;base64,${over}">`,
        inlineImages: [{ cid: 'a@host', partId: '1.1', mimeType: 'image/png' }] },
      { id: 'm2', userId: 'u1',
        bodyHtml: `<img src="data:image/png;base64,${PNG}">`,
        inlineImages: [{ cid: 'b@host', partId: '1.1', mimeType: 'image/png' }] },
      { id: 'm3', userId: 'u1',
        bodyHtml: `<img src="data:image/png;base64,${PNG}">`,
        inlineImages: [] },
      // Guard 1: a failed inline download left its mapping with no data URI.
      { id: 'm4', userId: 'u1',
        bodyHtml: `<img src="data:image/png;base64,${PNG}"><img src="">`,
        inlineImages: [{ cid: 'c@host', partId: '1.1', mimeType: 'image/png' }] },
    ];
    const db = fakeDb(rows);
    const c = cache();
    // m1 never reaches the cache (it is over the cap); m2's write is refused.
    c.write.mockResolvedValueOnce(false);
    const lines: string[] = [];

    const totals = await runBackfill(db as any, c, (l: string) => lines.push(l));

    expect(totals.skippedTooLarge).toBe(1);
    expect(totals.skippedWriteFailed).toBe(1);
    expect(totals.skippedAmbiguous).toBe(1);
    expect(totals.skippedBlankSrc).toBe(1);
    expect(totals.skipped).toBe(4);
    expect(totals.ambiguousIds).toEqual(['m3', 'm4']);

    const report = lines.join('\n');
    expect(report).toMatch(/1 over the per-image cap/);
    expect(report).toContain('INLINE_IMAGE_MAX_BYTES');
    expect(report).toMatch(/1 refused by the cache/);
    expect(report).toMatch(/1 in bodies skipped wholesale/);
    // The blank-src skips are reported as their own reason, not folded in.
    expect(report).toMatch(/1 in bodies carrying an empty src=""/);
    expect(report).toContain('ambiguous: m3');
    expect(report).toContain('ambiguous: m4');
  });

  it('reports nothing about reasons that did not occur', async () => {
    const db = fakeDb([convertible('m1')]);
    const lines: string[] = [];

    await runBackfill(db as any, cache(), (l: string) => lines.push(l));

    const report = lines.join('\n');
    expect(report).toMatch(/1\/1 bodies rewritten/);
    expect(report).not.toContain('over the per-image cap');
    expect(report).not.toContain('empty src=""');
    expect(report).not.toContain('ambiguous:');
  });
});

// ── The shapes actually on the boxes ────────────────────────────────────────
// Measured on 10.10.94.155, 2026-09-18, random sample of 600 of 4,264 rows:
// 81 data URIs in the plain `data:image/gif;base64,` form against 1,359 that
// carry a MIME parameter, and 792 where that parameter's own double quotes
// terminate the src attribute early. The plain form is 6% of the corpus.
describe('backfillMessage — the MIME-parameter forms real mail uses', () => {
  it('converts a data uri whose MIME type carries an unquoted name parameter', async () => {
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/gif; name=Odilo.gif;base64,${PNG}">`,
      inlineImages: [{ cid: 'c1', partId: '1.2.2', mimeType: 'image/gif' }],
    };

    const r = await backfillMessage(row as any, c);

    expect(r.html).toBe('<img src="cid:c1">');
    expect(r.written).toBe(1);
    expect(c.write).toHaveBeenCalledWith('u1', 'm1', '1.2.2', expect.any(Buffer));
  });

  it('converts a data uri whose name parameter is quoted, closing the src attribute early', async () => {
    // `src="data:image/gif; name="Paul Nshimyubutatu.gif";base64,…"` — the
    // parameter's quote ends the attribute as far as an HTML parser is
    // concerned, so this image does not render at all today. Converting it to
    // a cid: reference is what puts it back on screen.
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/gif; name="Paul Nshimyubutatu.gif";base64,${PNG}">`,
      inlineImages: [{ cid: 'c1', partId: '1.2.2', mimeType: 'image/gif' }],
    };

    const r = await backfillMessage(row as any, c);

    expect(r.html).toBe('<img src="cid:c1">');
    expect(r.written).toBe(1);
    expect((c.write.mock.calls[0][3] as Buffer).toString()).toBe('fakepng');
  });

  it('matches the parameterised MIME type against the mapping on its bare type', async () => {
    // Guard 3 compares declared types. `image/gif; name=x.gif` is image/gif.
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/jpeg; name=image001.jpg;base64,${PNG}">`,
      inlineImages: [{ cid: 'c1', partId: '2.2', mimeType: 'image/png' }],
    };

    const r = await backfillMessage(row as any, c);

    expect(r.written).toBe(0);
    expect(r.skippedAmbiguous).toBe(1);
  });

  it('counts a parameterised uri toward the guards, so a body of them is not silently half-converted', async () => {
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml:
        `<img src="data:image/gif; name=a.gif;base64,${PNG}">` +
        `<img src="data:image/gif; name="b.gif";base64,${PNG}">`,
      inlineImages: [{ cid: 'c1', partId: '1.1', mimeType: 'image/gif' }],
    };

    const r = await backfillMessage(row as any, c);

    expect(r.written).toBe(0);
    expect(r.skippedAmbiguous).toBe(2);
    expect(r.ambiguousBody).toBe(true);
  });

  it('handles the three forms side by side in one body, in document order', async () => {
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml:
        `<img src="data:image/png;base64,${PNG}">` +
        `<img src="data:image/gif; name=b.gif;base64,${PNG}">` +
        `<img src="data:image/jpeg; name="c jpeg.jpg";base64,${PNG}">`,
      inlineImages: [
        { cid: 'c1', partId: '1.1', mimeType: 'image/png' },
        { cid: 'c2', partId: '1.2', mimeType: 'image/gif' },
        { cid: 'c3', partId: '1.3', mimeType: 'image/jpeg' },
      ],
    };

    const r = await backfillMessage(row as any, c);

    expect(r.html).toBe('<img src="cid:c1"><img src="cid:c2"><img src="cid:c3">');
    expect(c.write.mock.calls.map((x: any[]) => x[2])).toEqual(['1.1', '1.2', '1.3']);
  });

  it('decodes a payload that carries line breaks', async () => {
    const c = cache();
    const wrapped = `${PNG.slice(0, 4)}\r\n${PNG.slice(4)}`;
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/png;base64,${wrapped}">`,
      inlineImages: [{ cid: 'c1', partId: '1.1', mimeType: 'image/png' }],
    };

    const r = await backfillMessage(row as any, c);

    expect(r.written).toBe(1);
    expect((c.write.mock.calls[0][3] as Buffer).toString()).toBe('fakepng');
  });
});
