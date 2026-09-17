import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import { join, resolve, sep, dirname } from 'path';
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
   *
   * The part id is HASHED rather than used as the filename. Zimbra's is "1.1.2",
   * but Exchange's is the EWS AttachmentId (ews.service.ts) — an opaque base64
   * blob of 150-400 characters that can contain `/` and `+`. Verbatim, that is
   * over the 255-byte filename limit, so every write on the Exchange box failed
   * ENAMETOOLONG, was swallowed by write()'s catch, and the cache stored nothing
   * at all: every message open refetched every inline image from EWS, silently
   * and forever. A `/` in the id also fanned one key out into nested directories.
   * Nothing ever reads a part id back out of a path — the evictor needs only size
   * and mtime — so a hash is a lossless key here.
   */
  pathFor(userId: string, messageId: string, partId: string): string {
    const name = createHash('sha256').update(partId, 'utf8').digest('hex');
    const full = resolve(join(this.root, userId, messageId, name));
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
      const dir = dirname(full);
      await fs.mkdir(dir, { recursive: true });

      // Write to a temp file first, then rename atomically. This ensures a
      // concurrent reader sees either the previous file or the complete new one,
      // never a partial file mid-write. Use a unique temp name (pid + random) per call
      // to prevent concurrent writes to the same path from corrupting each other, and
      // to make temp files recognizable to the cache evictor (Task 5).
      const pid = process.pid;
      const random = Math.random().toString(36).slice(2, 8);
      const tmp = `${full}.tmp-${pid}-${random}`;
      try {
        await fs.writeFile(tmp, data);
        await fs.rename(tmp, full);
      } catch (err: any) {
        // Clean up the temp file on any error (write, rename, etc).
        try {
          await fs.unlink(tmp);
        } catch {
          // If temp file doesn't exist or can't be deleted, ignore.
        }
        throw err;
      }
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
