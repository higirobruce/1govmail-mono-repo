import { promises as fs } from 'fs';
import { join } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CACHE_ROOT_DEFAULT } from './inline-image-cache.service';

const DEFAULTS = { maxAgeDays: 90, maxTotalBytes: 2 * 1024 * 1024 * 1024, maxRemovalsPerTick: 5000 };

// Same anchored regex Task 1 settled on for `<partId>.tmp-<pid>-<random>`.
// The marker is a suffix appended after the part id, so this must be
// anchored at the end — a `startsWith` check is wrong (the marker isn't a
// prefix) and a bare `.includes('.tmp-')` would misidentify a real part id
// that happens to contain that substring. Copied verbatim from Task 1, not
// reinvented.
const TEMP_FILE_RE = /\.tmp-\d+-[0-9a-z]+$/;

// A legitimate write-then-rename completes in well under a second. A temp
// file still on disk after this long survived a crash mid-write (the one
// failure mode InlineImageCacheService.write() cannot clean up after itself)
// and is pure litter, not a cache entry — the walk removes it on sight,
// unconditionally, regardless of the age/size accounting that governs real
// cache contents. Anything younger is left alone: it may be an in-flight
// write, and deleting out from under one would corrupt a concurrent read of
// the previous file via the temp-then-rename dance.
const STALE_TEMP_MS = 60 * 60 * 1000; // 1 hour

/** An empty env var yields NaN or 0; either would evict the whole cache. */
function positive(value: number | undefined, fallback: number, logger: Logger, name: string): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (value !== undefined) logger.warn(`${name}=${value} is not a positive number; using ${fallback}`);
  return fallback;
}

interface Entry { path: string; size: number; atimeMs: number }

/**
 * Ages the inline-image cache out, by horizon AND by total size. On a
 * disk-constrained box the ceiling matters more than the age. Also sweeps up
 * stale `.tmp-*` files left behind by a crashed write (see TEMP_FILE_RE)
 * without letting that cleanup compete with real eviction for the
 * per-tick removal budget.
 */
@Injectable()
export class InlineImageEvictWorker {
  private readonly logger = new Logger(InlineImageEvictWorker.name);
  readonly settings: { maxAgeDays: number; maxTotalBytes: number; maxRemovalsPerTick: number };

  constructor(
    private readonly root: string = CACHE_ROOT_DEFAULT,
    overrides: Partial<typeof DEFAULTS> = {},
  ) {
    this.settings = {
      maxAgeDays: positive(overrides.maxAgeDays ?? Number(process.env.INLINE_IMAGE_MAX_AGE_DAYS), DEFAULTS.maxAgeDays, this.logger, 'INLINE_IMAGE_MAX_AGE_DAYS'),
      maxTotalBytes: positive(overrides.maxTotalBytes ?? Number(process.env.INLINE_IMAGE_MAX_TOTAL_BYTES), DEFAULTS.maxTotalBytes, this.logger, 'INLINE_IMAGE_MAX_TOTAL_BYTES'),
      maxRemovalsPerTick: positive(overrides.maxRemovalsPerTick ?? Number(process.env.INLINE_IMAGE_MAX_REMOVALS), DEFAULTS.maxRemovalsPerTick, this.logger, 'INLINE_IMAGE_MAX_REMOVALS'),
    };
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM, { waitForCompletion: true })
  async tick(): Promise<void> {
    try {
      const { removed, bytesFreed, hitCeiling } = await this.processTick();
      const mb = Math.round(bytesFreed / 1048576);
      if (hitCeiling) {
        this.logger.warn(`inline image eviction: -${removed} files (${mb} MB); HIT THE CEILING, more remains`);
      } else {
        this.logger.log(`inline image eviction: -${removed} files (${mb} MB); nothing left to remove`);
      }
    } catch (err: any) {
      this.logger.error(`inline image eviction failed: ${err?.message}`);
    }
  }

  async processTick(): Promise<{ removed: number; bytesFreed: number; hitCeiling: boolean }> {
    let tempRemoved = 0;
    let tempBytesFreed = 0;

    const entries = await this.walk(this.root, async (path, size) => {
      try {
        await fs.unlink(path);
        tempRemoved++;
        tempBytesFreed += size;
      } catch { /* already gone */ }
    });

    const cutoff = Date.now() - this.settings.maxAgeDays * 86_400_000;

    // Least-recently-used first, so the size pass evicts the coldest.
    entries.sort((a, b) => a.atimeMs - b.atimeMs);

    const doomed: Entry[] = entries.filter((e) => e.atimeMs < cutoff);
    const keep = entries.filter((e) => e.atimeMs >= cutoff);
    let total = keep.reduce((n, e) => n + e.size, 0);
    for (const e of keep) {
      if (total <= this.settings.maxTotalBytes) break;
      doomed.push(e);
      total -= e.size;
    }

    let removed = 0;
    let bytesFreed = 0;
    for (const e of doomed) {
      if (removed >= this.settings.maxRemovalsPerTick) {
        return { removed: removed + tempRemoved, bytesFreed: bytesFreed + tempBytesFreed, hitCeiling: true };
      }
      try { await fs.unlink(e.path); removed++; bytesFreed += e.size; } catch { /* already gone */ }
    }
    return { removed: removed + tempRemoved, bytesFreed: bytesFreed + tempBytesFreed, hitCeiling: false };
  }

  private async walk(
    dir: string,
    onStaleTemp: (path: string, size: number) => Promise<void>,
  ): Promise<Entry[]> {
    let names: string[];
    try { names = await fs.readdir(dir); } catch { return []; }
    const out: Entry[] = [];
    for (const name of names) {
      const full = join(dir, name);
      try {
        const st = await fs.stat(full);
        if (st.isDirectory()) {
          out.push(...(await this.walk(full, onStaleTemp)));
        } else if (TEMP_FILE_RE.test(name)) {
          // Never a cache entry: excluded from age/size accounting entirely.
          // Only cleaned up once old enough to be certainly abandoned.
          if (Date.now() - st.mtimeMs > STALE_TEMP_MS) {
            await onStaleTemp(full, st.size);
          }
        } else {
          out.push({ path: full, size: st.size, atimeMs: st.mtimeMs });
        }
      } catch { /* vanished mid-walk */ }
    }
    return out;
  }
}
