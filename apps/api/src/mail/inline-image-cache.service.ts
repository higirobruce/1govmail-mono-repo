import { promises as fs } from 'fs';
import { join, resolve, sep } from 'path';
import { Injectable, Logger } from '@nestjs/common';

export const CACHE_ROOT_DEFAULT = process.env.INLINE_IMAGE_CACHE_DIR ?? '/opt/govmail/imgcache';

/** One 133 MB image must not be able to own the cache. Over this, serve through. */
export const MAX_FILE_BYTES = Number(process.env.INLINE_IMAGE_MAX_BYTES ?? 5 * 1024 * 1024);

/**
 * Bytes for inline images, on disk, keyed by user + message + part.
 *
 * This cache is authoritative for NOTHING: every entry is rebuildable from the
 * provider via the message's `inlineImages` mapping. That is what makes it safe
 * to evict, safe to lose, and correct to exclude from backups — and it is why
 * every failure path here degrades to "no cache" rather than throwing.
 */
@Injectable()
export class InlineImageCacheService {
  private readonly logger = new Logger(InlineImageCacheService.name);
  private warnedUnwritable = false;

  constructor(private readonly root: string = CACHE_ROOT_DEFAULT) {}

  get CACHE_ROOT(): string {
    return this.root;
  }

  /**
   * Resolve and verify the path stays inside the user's directory. A part id
   * and message id arrive from the URL, so a traversing value would otherwise
   * read or write outside the caller's own directory — this is the tenancy boundary.
   */
  pathFor(userId: string, messageId: string, partId: string): string {
    const full = resolve(join(this.root, userId, messageId, partId));
    const userBase = resolve(join(this.root, userId)) + sep;
    if (!full.startsWith(userBase)) {
      throw new Error('inline image path escapes the cache root');
    }
    return full;
  }

  async read(userId: string, messageId: string, partId: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.pathFor(userId, messageId, partId));
    } catch {
      return null;
    }
  }

  /** Returns false when the write was skipped — over cap, or the cache is unusable. */
  async write(userId: string, messageId: string, partId: string, data: Buffer): Promise<boolean> {
    if (data.byteLength > MAX_FILE_BYTES) return false;
    try {
      const full = this.pathFor(userId, messageId, partId);
      await fs.mkdir(join(full, '..'), { recursive: true });
      await fs.writeFile(full, data);
      return true;
    } catch (err: any) {
      // Log once. A cache that cannot be written is a degraded cache, not an
      // outage, and it must not produce a line per image on every open.
      if (!this.warnedUnwritable) {
        this.warnedUnwritable = true;
        this.logger.warn(`inline image cache unwritable (${err?.message}); serving through`);
      }
      return false;
    }
  }
}
