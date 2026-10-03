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
function positive(value: number, fallback: number, logger: Logger, name: string): number {
  if (Number.isFinite(value) && value > 0) return value;
  logger.warn(`${name}=${value} is not a positive number; using ${fallback}`);
  return fallback;
}

/**
 * Resolves one tunable setting from an explicit override, then an env var,
 * then a hardcoded default — warning only when a value was actually
 * *supplied* (by override or by a set env var) and rejected. An env var that
 * was simply never set must fall back silently: on both VMs, none of these
 * three are configured, and a guard that warns on every ordinary boot trains
 * whoever reads the journal to ignore the line that would have mattered.
 */
function resolveSetting(
  overrideValue: number | undefined,
  envValue: string | undefined,
  fallback: number,
  logger: Logger,
  name: string,
): number {
  if (overrideValue !== undefined) return positive(overrideValue, fallback, logger, name);
  if (envValue === undefined) return fallback;
  return positive(Number(envValue), fallback, logger, name);
}

interface Entry { path: string; size: number; lastUsedMs: number }

type UnlinkOutcome = 'removed' | 'alreadyGone' | 'failed';

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
      maxAgeDays: resolveSetting(overrides.maxAgeDays, process.env.INLINE_IMAGE_MAX_AGE_DAYS, DEFAULTS.maxAgeDays, this.logger, 'INLINE_IMAGE_MAX_AGE_DAYS'),
      maxTotalBytes: resolveSetting(overrides.maxTotalBytes, process.env.INLINE_IMAGE_MAX_TOTAL_BYTES, DEFAULTS.maxTotalBytes, this.logger, 'INLINE_IMAGE_MAX_TOTAL_BYTES'),
      maxRemovalsPerTick: resolveSetting(overrides.maxRemovalsPerTick, process.env.INLINE_IMAGE_MAX_REMOVALS, DEFAULTS.maxRemovalsPerTick, this.logger, 'INLINE_IMAGE_MAX_REMOVALS'),
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
    // A file this tick selected for removal that survives it (permission
    // error, busy handle, anything but "it was already gone") means the tick
    // did not finish its work, even if it never reached the removal-count
    // ceiling. Folding this into hitCeiling is deliberate: "hitCeiling" means
    // "work remains", and a failed unlink is exactly that.
    let sawUnlinkFailure = false;

    const entries = await this.walk(this.root, async (path, size) => {
      const outcome = await this.tryUnlink(path);
      if (outcome === 'removed') {
        tempRemoved++;
        tempBytesFreed += size;
      } else if (outcome === 'failed') {
        sawUnlinkFailure = true;
      }
    });

    const cutoff = Date.now() - this.settings.maxAgeDays * 86_400_000;

    // Least-recently-used first, so the size pass evicts the coldest.
    entries.sort((a, b) => a.lastUsedMs - b.lastUsedMs);

    const doomed: Entry[] = entries.filter((e) => e.lastUsedMs < cutoff);
    const keep = entries.filter((e) => e.lastUsedMs >= cutoff);
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
      const outcome = await this.tryUnlink(e.path);
      if (outcome === 'removed') {
        removed++;
        bytesFreed += e.size;
      } else if (outcome === 'failed') {
        sawUnlinkFailure = true;
      }
    }
    return {
      removed: removed + tempRemoved,
      bytesFreed: bytesFreed + tempBytesFreed,
      hitCeiling: sawUnlinkFailure,
    };
  }

  /**
   * ENOENT means the file is genuinely already gone — a race with another
   * cleanup, not a problem. Anything else (EACCES, EPERM, EBUSY, ...) is a
   * real failure: the file is still there and the caller must not count it
   * as removed or claim the tick finished.
   */
  private async tryUnlink(path: string): Promise<UnlinkOutcome> {
    try {
      await fs.unlink(path);
      return 'removed';
    } catch (err: any) {
      if (err?.code === 'ENOENT') return 'alreadyGone';
      this.logger.warn(`inline image eviction: could not remove ${path}: ${err?.message}`);
      return 'failed';
    }
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
          // Recency of *use*, not of write: these files are written once and
          // never rewritten, so mtime alone makes eviction FIFO-by-fill-time
          // rather than LRU — a frequently reopened image would be exactly
          // as evictable as one nobody has looked at since. atime tracks
          // reads (subject to the volume's atime/relatime/noatime mount
          // policy); mtime is the floor it never goes below. Taking the max
          // gives genuine recency where atime is tracked and degrades safely
          // to write time where it isn't.
          out.push({ path: full, size: st.size, lastUsedMs: Math.max(st.atimeMs, st.mtimeMs) });
        }
      } catch { /* vanished mid-walk */ }
    }
    return out;
  }
}
