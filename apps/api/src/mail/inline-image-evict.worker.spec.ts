import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { InlineImageEvictWorker } from './inline-image-evict.worker';

function put(root: string, rel: string, bytes: number, ageDays = 0) {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, Buffer.alloc(bytes));
  const t = Date.now() / 1000 - ageDays * 86400;
  utimesSync(full, t, t);
  return full;
}

describe('InlineImageEvictWorker', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'evict-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('removes files past the age horizon', async () => {
    const old = put(root, 'u1/m1/1.1', 10, 120);
    const fresh = put(root, 'u1/m1/1.2', 10, 1);
    const w = new InlineImageEvictWorker(root, { maxAgeDays: 90, maxTotalBytes: 1e9 });

    const r = await w.processTick();

    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(r.removed).toBe(1);
  });

  it('enforces the size ceiling by evicting least-recently-used first', async () => {
    const oldest = put(root, 'u1/m1/a', 100, 5);
    const newer  = put(root, 'u1/m1/b', 100, 2);
    const newest = put(root, 'u1/m1/c', 100, 1);
    const w = new InlineImageEvictWorker(root, { maxAgeDays: 90, maxTotalBytes: 250 });

    await w.processTick();

    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(newer)).toBe(true);
    expect(existsSync(newest)).toBe(true);
  });

  it('does nothing when under the ceiling and inside the horizon', async () => {
    const f = put(root, 'u1/m1/a', 10, 1);
    const w = new InlineImageEvictWorker(root, { maxAgeDays: 90, maxTotalBytes: 1e9 });

    const r = await w.processTick();

    expect(existsSync(f)).toBe(true);
    expect(r.removed).toBe(0);
    expect(r.hitCeiling).toBe(false);
  });

  it('reports hitting the ceiling so a sweep that never catches up is visible', async () => {
    for (let i = 0; i < 5; i++) put(root, `u1/m1/f${i}`, 100, 1);
    const w = new InlineImageEvictWorker(root, { maxAgeDays: 90, maxTotalBytes: 250, maxRemovalsPerTick: 1 });

    const r = await w.processTick();

    expect(r.removed).toBe(1);
    expect(r.hitCeiling).toBe(true);
  });

  it('falls back to the default when a setting is zero or not a number', () => {
    // An empty env var parses to 0, which would set the horizon to now and
    // delete the entire cache on the next tick.
    const w = new InlineImageEvictWorker(root, { maxAgeDays: 0, maxTotalBytes: NaN });
    expect(w.settings.maxAgeDays).toBe(90);
    expect(w.settings.maxTotalBytes).toBeGreaterThan(0);
  });

  it('does not throw when the cache directory does not exist', async () => {
    const w = new InlineImageEvictWorker(join(root, 'nope'), { maxAgeDays: 90, maxTotalBytes: 1e9 });
    await expect(w.processTick()).resolves.toMatchObject({ removed: 0 });
  });

  // Task 1's write() renames a temp file into place; a crash between the
  // write and the rename leaves the temp file behind forever unless
  // something else cleans it up. These two pin the decision made for this
  // worker: stale temp litter is cleaned up outright, but a temp file young
  // enough to plausibly be an in-flight write is left alone and is never
  // treated as a cache entry.
  it('cleans up a temp file abandoned by a crashed write', async () => {
    // 0.2 days = 4.8h, well past the 1h staleness threshold.
    const stale = put(root, 'u1/m1/1.1.tmp-4242-abcdef', 50, 0.2);
    const w = new InlineImageEvictWorker(root, { maxAgeDays: 90, maxTotalBytes: 1e9 });

    const r = await w.processTick();

    expect(existsSync(stale)).toBe(false);
    expect(r.removed).toBe(1);
    expect(r.bytesFreed).toBe(50);
  });

  it('leaves a fresh temp file alone and never counts it toward the size ceiling', async () => {
    const real = put(root, 'u1/m1/a', 50, 1);
    // A large fresh temp file: if it were counted as a normal cache entry,
    // its size alone would force the (older) real entry out to fit the tiny
    // ceiling below.
    const inflight = put(root, 'u1/m1/a.tmp-4242-abcdef', 300, 0);
    const w = new InlineImageEvictWorker(root, { maxAgeDays: 90, maxTotalBytes: 100 });

    await w.processTick();

    expect(existsSync(real)).toBe(true);
    expect(existsSync(inflight)).toBe(true);
  });
});
