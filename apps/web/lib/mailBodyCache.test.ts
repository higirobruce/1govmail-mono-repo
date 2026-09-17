import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getCachedBody,
  setCachedBody,
  fetchBodyCached,
  clearBodyCache,
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
});
