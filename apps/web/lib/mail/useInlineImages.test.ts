import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useInlineImages, FLUSH_INTERVAL_MS } from './useInlineImages';

vi.mock('@/lib/api', () => ({
  api: { mail: { inlineImage: vi.fn() } },
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { api } from '@/lib/api';

const inlineImage = api.mail.inlineImage as unknown as ReturnType<typeof vi.fn>;

/**
 * Each distinct Map identity this hook hands back is a full rebuild of the
 * sandboxed iframe's srcDoc in both readers: a document reload, a flicker, a
 * height re-measure, an in-frame scroll reset, and one more multi-megabyte
 * string through the 20-entry prepareEmailHtml LRU (which holds 20 bodies for
 * the whole app). One rebuild per image is what image-heavy newsletters — this
 * feature's whole subject — used to cost.
 */
function renderCountingMaps(
  messageId: string | null,
  images: Array<{ cid: string; partId: string }> | undefined,
) {
  const seen: Array<Map<string, string>> = [];
  const view = renderHook(
    ({ id, imgs }: { id: string | null; imgs: typeof images }) => {
      const m = useInlineImages(id, imgs);
      seen.push(m);
      return m;
    },
    { initialProps: { id: messageId, imgs: images } },
  );
  return { ...view, distinctMaps: () => new Set(seen).size };
}

/** A promise plus the handles to settle it later. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const IMAGES = [
  { cid: 'a@host', partId: '1.1' },
  { cid: 'b@host', partId: '1.2' },
  { cid: 'c@host', partId: '1.3' },
  { cid: 'd@host', partId: '1.4' },
  { cid: 'e@host', partId: '1.5' },
];

// jsdom's URL has no object-URL methods at all, so they are installed for the
// whole file rather than spied on — testing-library's own afterEach cleanup
// unmounts (and therefore revokes) after this file's hooks have run.
const revoke = vi.fn();
(URL as unknown as Record<string, unknown>).revokeObjectURL = revoke;
(URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => 'blob:new');

describe('useInlineImages', () => {
  beforeEach(() => {
    inlineImage.mockReset();
    revoke.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('rebuilds the map once for all the arrivals inside one flush window', async () => {
    // Each arrival lands in its OWN tick, so React cannot batch them: without
    // the pending map every one of them is a separate iframe rebuild. Four of
    // the five resolve, so nothing is published by the all-settled path and
    // the interval is the only thing that can show them.
    vi.useFakeTimers();
    const d = IMAGES.map(() => deferred<string>());
    let i = 0;
    inlineImage.mockImplementation(() => d[i++].promise);

    const view = renderCountingMaps('m1', IMAGES);

    for (let n = 0; n < 4; n++) {
      await act(async () => {
        d[n].resolve(`blob:${n}`);
        await Promise.resolve();
        vi.advanceTimersByTime(10); // 40 ms in total — one window, comfortably
      });
    }

    // Held, not shown one by one.
    expect(view.result.current.size).toBe(0);

    await act(async () => { vi.advanceTimersByTime(FLUSH_INTERVAL_MS); });

    expect(view.result.current.size).toBe(4);
    // The empty map the effect starts from, plus exactly one populated map.
    expect(view.distinctMaps()).toBe(2);
  });

  it('keeps publishing later windows instead of waiting for the slowest image', async () => {
    // The interval has to REPEAT. With a one-shot timer the reader sees the
    // first window and then nothing at all until the last image settles — on a
    // cache-miss open that is a live provider download per part.
    vi.useFakeTimers();
    const d = IMAGES.map(() => deferred<string>());
    let i = 0;
    inlineImage.mockImplementation(() => d[i++].promise);

    const view = renderCountingMaps('m1', IMAGES);

    // Three arrivals, each a full window apart. Two images stay in flight
    // throughout, so nothing here is the all-settled flush.
    for (let n = 0; n < 3; n++) {
      await act(async () => {
        d[n].resolve(`blob:${n}`);
        await Promise.resolve();
        vi.advanceTimersByTime(FLUSH_INTERVAL_MS + 10);
      });
      expect(view.result.current.size).toBe(n + 1);
    }

    // Still bounded: the empty map plus one rebuild per window that had
    // something new in it — never one per image beyond that.
    expect(view.distinctMaps()).toBe(4);
  });

  it('shows the images that have arrived without waiting for a slow one', async () => {
    vi.useFakeTimers();
    const d = IMAGES.map(() => deferred<string>());
    let i = 0;
    inlineImage.mockImplementation(() => d[i++].promise);

    const view = renderCountingMaps('m1', IMAGES);

    await act(async () => {
      d[0].resolve('blob:0');
      d[1].resolve('blob:1');
      await Promise.resolve();
      vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    });

    // Three images are still in flight; the two that landed are already usable.
    expect(view.result.current.get('a@host')).toBe('blob:0');
    expect(view.result.current.get('b@host')).toBe('blob:1');
    expect(view.result.current.size).toBe(2);
  });

  it('keys by the cid verbatim, leaving normalisation to rewriteCidRefs', async () => {
    inlineImage.mockResolvedValue('blob:x');

    const view = renderCountingMaps('m1', [{ cid: '<Img0@Host>', partId: '1.1' }]);

    await waitFor(() => expect(view.result.current.size).toBe(1));
    expect(view.result.current.get('<Img0@Host>')).toBe('blob:x');
  });

  it('revokes every url it created when the message changes or the reader unmounts', async () => {
    inlineImage.mockImplementation((_id: string, part: string) =>
      Promise.resolve(`blob:${part}`));

    const view = renderCountingMaps('m1', IMAGES);
    await waitFor(() => expect(view.result.current.size).toBe(5));

    view.unmount();

    const revoked = revoke.mock.calls.map((c) => c[0]).sort();
    expect(revoked).toEqual(IMAGES.map((x) => `blob:${x.partId}`).sort());
  });

  it('revokes a url that resolves after unmount instead of leaking it', async () => {
    const late = deferred<string>();
    inlineImage.mockReturnValue(late.promise);

    const view = renderCountingMaps('m1', [{ cid: 'a@host', partId: '1.1' }]);
    view.unmount();

    await act(async () => {
      late.resolve('blob:late');
      await Promise.resolve();
    });

    expect(revoke).toHaveBeenCalledWith('blob:late');
  });

  it('does not fetch anything for a message with no inline images', () => {
    const view = renderCountingMaps('m1', []);
    expect(inlineImage).not.toHaveBeenCalled();
    expect(view.result.current.size).toBe(0);
  });

  it('survives an image that fails without losing the ones that worked', async () => {
    inlineImage
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValueOnce('blob:ok');

    const view = renderCountingMaps('m1', [
      { cid: 'a@host', partId: '1.1' },
      { cid: 'b@host', partId: '1.2' },
    ]);

    await waitFor(() => expect(view.result.current.size).toBe(1));
    expect(view.result.current.get('b@host')).toBe('blob:ok');
  });
});
