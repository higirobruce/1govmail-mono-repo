import { backfillMessage } from './backfill-inline-images';

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
});
