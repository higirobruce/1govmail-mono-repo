import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getCachedBody,
  setCachedBody,
  fetchBodyCached,
  clearBodyCache,
  watchPendingBody,
} from './mailBodyCache';

describe('mailBodyCache', () => {
  beforeEach(() => clearBodyCache());

  it('stores and returns a body by id', () => {
    const body = { id: 'm1', bodyHtml: '<p>hi</p>' };
    setCachedBody('m1', body);
    expect(getCachedBody('m1')).toBe(body); // same reference
    expect(getCachedBody('missing')).toBeUndefined();
  });

  it('ignores empty ids and null bodies', () => {
    setCachedBody('', { a: 1 });
    setCachedBody('m1', null);
    setCachedBody('m2', undefined);
    expect(getCachedBody('')).toBeUndefined();
    expect(getCachedBody('m1')).toBeUndefined();
    expect(getCachedBody('m2')).toBeUndefined();
  });

  it('evicts the least-recently-used entry past the cap of 40', () => {
    for (let i = 0; i < 40; i++) setCachedBody(`m${i}`, { i });
    // Touch m0 so it is no longer the LRU.
    expect(getCachedBody('m0')).toEqual({ i: 0 });
    // Insert a 41st entry — the LRU (now m1) should be evicted, m0 retained.
    setCachedBody('m40', { i: 40 });
    expect(getCachedBody('m0')).toEqual({ i: 0 });
    expect(getCachedBody('m1')).toBeUndefined();
    expect(getCachedBody('m40')).toEqual({ i: 40 });
  });

  it('fetchBodyCached returns the cached body without calling the fetcher', async () => {
    const body = { id: 'm1' };
    setCachedBody('m1', body);
    const fetcher = vi.fn();
    await expect(fetchBodyCached('m1', fetcher)).resolves.toBe(body);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fetchBodyCached fetches, caches, and de-duplicates concurrent calls', async () => {
    const body = { id: 'm2' };
    const fetcher = vi.fn().mockResolvedValue(body);
    // Two concurrent callers for the same id share one request.
    const [a, b] = await Promise.all([
      fetchBodyCached('m2', fetcher),
      fetchBodyCached('m2', fetcher),
    ]);
    expect(a).toBe(body);
    expect(b).toBe(body);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Subsequent call is served from cache.
    await fetchBodyCached('m2', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(getCachedBody('m2')).toBe(body);
  });

  it('fetchBodyCached does not cache a rejected fetch and allows a retry', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'm3' });
    await expect(fetchBodyCached('m3', fetcher)).rejects.toThrow('boom');
    expect(getCachedBody('m3')).toBeUndefined();
    await expect(fetchBodyCached('m3', fetcher)).resolves.toEqual({ id: 'm3' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('clearBodyCache drops everything', () => {
    setCachedBody('m1', { a: 1 });
    clearBodyCache();
    expect(getCachedBody('m1')).toBeUndefined();
  });

  it('setCachedBody refuses to cache an embedPending body (a poll must refetch it)', () => {
    setCachedBody('m1', { id: 'm1', bodyHtml: '<p>raw</p>', embedPending: true });
    expect(getCachedBody('m1')).toBeUndefined();
  });

  it('fetchBodyCached returns an embedPending body but does not cache it', async () => {
    const pending = { id: 'm1', bodyHtml: '<p>raw</p>', embedPending: true };
    const fetcher = vi.fn().mockResolvedValue(pending);
    await expect(fetchBodyCached('m1', fetcher)).resolves.toBe(pending);
    expect(getCachedBody('m1')).toBeUndefined();
    // A second call fetches again instead of serving the stale pending copy.
    await fetchBodyCached('m1', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('watchPendingBody', () => {
  beforeEach(() => {
    clearBodyCache();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls until embedPending clears, then caches the final body and calls onFinal', async () => {
    const pending = { id: 'm1', bodyHtml: '<p>raw</p>', embedPending: true };
    const final = { id: 'm1', bodyHtml: '<p>embedded</p>' };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(final);
    const onFinal = vi.fn();

    watchPendingBody('m1', fetcher, onFinal);

    await vi.advanceTimersByTimeAsync(2500); // poll 1 → still pending
    expect(onFinal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2500); // poll 2 → final
    expect(onFinal).toHaveBeenCalledWith(final);
    expect(getCachedBody('m1')).toBe(final);

    // No further polls after the final body landed.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('shares one poll loop per id but notifies every subscriber (detail pane + thread message)', async () => {
    const final = { id: 'm1', bodyHtml: '<p>embedded</p>' };
    const fetcher = vi.fn().mockResolvedValue(final);
    const onFinalA = vi.fn();
    const onFinalB = vi.fn();

    watchPendingBody('m1', fetcher, onFinalA);
    watchPendingBody('m1', fetcher, onFinalB);

    await vi.advanceTimersByTimeAsync(2500);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onFinalA).toHaveBeenCalledWith(final);
    expect(onFinalB).toHaveBeenCalledWith(final);
  });

  it('gives up after the max attempts without caching a pending body', async () => {
    const pending = { id: 'm1', bodyHtml: '<p>raw</p>', embedPending: true };
    const fetcher = vi.fn().mockResolvedValue(pending);
    const onFinal = vi.fn();

    watchPendingBody('m1', fetcher, onFinal);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(8);
    expect(onFinal).not.toHaveBeenCalled();
    expect(getCachedBody('m1')).toBeUndefined();

    // The watcher slot is freed — a later watch can start fresh.
    const final = { id: 'm1', bodyHtml: '<p>embedded</p>' };
    fetcher.mockResolvedValue(final);
    watchPendingBody('m1', fetcher, onFinal);
    await vi.advanceTimersByTimeAsync(2500);
    expect(onFinal).toHaveBeenCalledWith(final);
  });

  it('stops polling when clearBodyCache runs (logout mid-poll)', async () => {
    const pending = { id: 'm1', bodyHtml: '<p>raw</p>', embedPending: true };
    const fetcher = vi.fn().mockResolvedValue(pending);
    const onFinal = vi.fn();

    watchPendingBody('m1', fetcher, onFinal);
    await vi.advanceTimersByTimeAsync(2500);
    const callsBeforeClear = fetcher.mock.calls.length;

    clearBodyCache();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher.mock.calls.length).toBe(callsBeforeClear);
    expect(onFinal).not.toHaveBeenCalled();
  });

  it('stops quietly when a poll rejects (network blip) without caching anything', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    const onFinal = vi.fn();

    watchPendingBody('m1', fetcher, onFinal);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onFinal).not.toHaveBeenCalled();
    expect(getCachedBody('m1')).toBeUndefined();
  });
});
