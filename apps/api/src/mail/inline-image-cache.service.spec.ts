import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { InlineImageCacheService, MAX_FILE_BYTES } from './inline-image-cache.service';

// Temp files are named `<partId>.tmp-<pid>-<random>` — the marker is a suffix
// appended after the part id, not a bare substring. Anchoring to the actual
// suffix shape (rather than `.includes('.tmp-')`) means a part id that itself
// contained the literal text `.tmp-` can never be mistaken for cache litter.
const isTempFile = (name: string): boolean => /\.tmp-\d+-[0-9a-z]+$/.test(name);

describe('InlineImageCacheService', () => {
  let root: string;
  let svc: InlineImageCacheService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'imgcache-'));
    svc = new InlineImageCacheService(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

  it('keys the path by user, message and a hash of the part', () => {
    expect(svc.pathFor('u1', 'm1', '1.1.2')).toBe(join(root, 'u1', 'm1', sha('1.1.2')));
  });

  it('refuses a message id that would escape the cache root', () => {
    // A traversing id must not be able to read or write outside the user's own
    // directory. This is the tenancy boundary, not a tidiness rule.
    expect(() => svc.pathFor('u1', '../u2', '1.1')).toThrow();
  });

  it('neutralises a traversing part id instead of letting it reach the filesystem', () => {
    // The part id is hashed, so it cannot contribute path syntax at all; the
    // containment check below is the belt to that pair of braces.
    const p = svc.pathFor('u1', 'm1', '../../../../etc/passwd');
    expect(p).toBe(join(root, 'u1', 'm1', sha('../../../../etc/passwd')));
    expect(p.startsWith(join(root, 'u1'))).toBe(true);
  });

  // ── C8: an EWS AttachmentId is not a safe filename ───────────────────────
  // Zimbra part ids look like "1.1.2". Exchange gives the EWS AttachmentId/@Id
  // (ews.service.ts:544) — an opaque base64 blob, routinely 150-400 characters,
  // containing `/` and `+`. Used verbatim as the final path component that is
  // over the 255-byte filename limit, so writeFile fails ENAMETOOLONG, write()
  // swallows it and returns false, and the cache silently stores NOTHING on the
  // Exchange box: every message open refetches every inline image, forever.

  const EWS_ATTACHMENT_ID =
    'AAMkADk3ZmQxZTJhLTk5NTUtNDU5Yi04ZGIyLTQ0ZTdkNzRjMGEyYgBGAAAAAAB' +
    'hR7s9jK+pTZ0QwPqVnZ1TBwCr3f/lK2nTQpXlS8mA0NlsAAAAAAEMAACr3f+lK2' +
    'nTQpXlS8mA0NlsAAAG9fJ3AAABEgAQANn4k8Fk3rBLl0Ck3wQ0Yz8=/ASAWlwWs' +
    'hAdKm7uDqMVn7+gABEgAQANn4k8Fk3rBLl0Ck3wQ0Yz8AAAABDgAAAABEgAQANn' +
    '4k8Fk3rBLl0Ck3wQ0Yz8AAAG9fJ3AAABEgAQAJ+KpWnbMU9NpAtVZ3n1ThYAAAA' +
    'BDwAAAA==';

  // The same thing without a `/` anywhere in it — the shape that hits the
  // 255-byte limit on a single path component instead of fanning out into
  // directories that happen to stay under it.
  const EWS_ATTACHMENT_ID_UNSPLIT = EWS_ATTACHMENT_ID.replace(/\//g, 'Q');

  it('round-trips an EWS AttachmentId longer than the filesystem name limit', async () => {
    expect(EWS_ATTACHMENT_ID_UNSPLIT.length).toBeGreaterThan(255);
    expect(EWS_ATTACHMENT_ID_UNSPLIT).not.toContain('/');
    const data = Buffer.from('exchange-inline-image-bytes');

    expect(await svc.write('u1', 'm1', EWS_ATTACHMENT_ID_UNSPLIT, data)).toBe(true);
    expect(await svc.read('u1', 'm1', EWS_ATTACHMENT_ID_UNSPLIT)).toEqual(data);
  });

  it('keeps an EWS AttachmentId in one flat directory despite the slashes in it', async () => {
    // A `/` inside the id would otherwise silently become nested directories,
    // breaking the evictor's depth assumption and any manual inspection.
    expect(EWS_ATTACHMENT_ID).toContain('/');
    await svc.write('u1', 'm1', EWS_ATTACHMENT_ID, Buffer.from('x'));

    const messageDir = join(root, 'u1', 'm1');
    const names = readdirSync(messageDir);
    expect(names).toEqual([sha(EWS_ATTACHMENT_ID)]);
    expect(names[0].length).toBeLessThanOrEqual(255);
  });

  it('gives two different part ids two different files', async () => {
    await svc.write('u1', 'm1', '1.1', Buffer.from('first'));
    await svc.write('u1', 'm1', '1.2', Buffer.from('second'));
    expect(await svc.read('u1', 'm1', '1.1')).toEqual(Buffer.from('first'));
    expect(await svc.read('u1', 'm1', '1.2')).toEqual(Buffer.from('second'));
  });

  it('returns null for a miss', async () => {
    expect(await svc.read('u1', 'm1', '1.1')).toBeNull();
  });

  it('round-trips a written buffer', async () => {
    const data = Buffer.from('imagebytes');
    expect(await svc.write('u1', 'm1', '1.1', data)).toBe(true);
    expect(await svc.read('u1', 'm1', '1.1')).toEqual(data);
  });

  it('does not write a file over the per-file cap', async () => {
    const huge = Buffer.alloc(MAX_FILE_BYTES + 1);
    expect(await svc.write('u1', 'm1', '1.1', huge)).toBe(false);
    expect(await svc.read('u1', 'm1', '1.1')).toBeNull();
  });

  it('writes a file exactly at the cap', async () => {
    const atCap = Buffer.alloc(MAX_FILE_BYTES);
    expect(await svc.write('u1', 'm1', '1.1', atCap)).toBe(true);
  });

  it('reports failure instead of throwing when mkdir fails', async () => {
    // A broken cache must degrade to serving straight through.
    // Use a regular file as the cache root so mkdir(root/u1) fails with ENOTDIR,
    // deterministically, for any user including root.
    const badRoot = join(tmpdir(), 'imgcache-file-' + Date.now());
    writeFileSync(badRoot, 'a file, not a directory');
    const badSvc = new InlineImageCacheService(badRoot);
    await expect(badSvc.write('u1', 'm1', '1.1', Buffer.from('x'))).resolves.toBe(false);
    rmSync(badRoot, { force: true });
  });

  it('reports a miss instead of throwing when a read fails (ENOENT)', async () => {
    const dir = join(root, 'u1', 'm1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '1.1'), 'ok');
    expect(existsSync(join(dir, '1.1'))).toBe(true);
    expect(await svc.read('u1', 'nope', '1.1')).toBeNull();
  });

  it('reports a miss instead of throwing when a read fails (EISDIR)', async () => {
    // A path that is a directory, not a file, should be read as null, not throw.
    // Built through pathFor so it lands on the hashed name the read will use.
    const dir = svc.pathFor('u1', 'm1', '1.1');
    mkdirSync(dir, { recursive: true });
    expect(existsSync(dir)).toBe(true);
    expect(await svc.read('u1', 'm1', '1.1')).toBeNull();
  });

  it('cleans up the temp file after a successful write', async () => {
    // Atomic write uses a temp file: after write completes, the temp should be gone
    // (rename moves it, so this also guards against a copy-and-forget regression).
    const data = Buffer.from('atomic');
    const path = svc.pathFor('u1', 'm1', '1.1');
    expect(await svc.write('u1', 'm1', '1.1', data)).toBe(true);
    // The target file should exist.
    expect(existsSync(path)).toBe(true);
    // No temp file (`<partId>.tmp-<pid>-<random>`) should remain in the directory.
    const leftover = readdirSync(dirname(path)).filter(isTempFile);
    expect(leftover).toEqual([]);
  });

  it('round-trips idempotently: second write of different content replaces old', async () => {
    // Verify atomicity: the file is either old or new, never partial.
    const data1 = Buffer.from('original');
    const data2 = Buffer.from('updated with different content');
    expect(await svc.write('u1', 'm1', '1.1', data1)).toBe(true);
    const read1 = await svc.read('u1', 'm1', '1.1');
    expect(read1).toEqual(data1);
    expect(await svc.write('u1', 'm1', '1.1', data2)).toBe(true);
    const read2 = await svc.read('u1', 'm1', '1.1');
    expect(read2).toEqual(data2);
    expect(read2).not.toEqual(data1);
    // After both writes, no temp file should exist.
    const path = svc.pathFor('u1', 'm1', '1.1');
    const leftover = readdirSync(dirname(path)).filter(isTempFile);
    expect(leftover).toEqual([]);
  });

  it('cleans up temp file when writeFile succeeds but rename fails', async () => {
    // Simulate a rename failure after successful writeFile. Pre-create the target
    // as a directory so rename() will fail (can't rename file onto a directory).
    // The unlink-in-catch path must execute and clean up the temp file.
    const data = Buffer.from('test');
    const path = svc.pathFor('u1', 'm1', '1.1');
    const dir = join(path, '..');

    // Pre-create the target as a directory so rename() will fail
    mkdirSync(dir, { recursive: true });
    mkdirSync(path, { recursive: true });

    const result = await svc.write('u1', 'm1', '1.1', data);
    expect(result).toBe(false);
    // The target directory still exists (we created it), but no temp file should be left
    const files = readdirSync(dir);
    // Temp files are named `<partId>.tmp-<pid>-<random>` — the marker is a
    // suffix on a name that begins with the part id, not a prefix.
    const tmpFiles = files.filter(isTempFile);
    expect(tmpFiles).toEqual([]);
  });

  it('does not corrupt the previously cached file when writeFile fails partway through', async () => {
    // mkdir succeeds here (the parent directory is untouched); only the write
    // to the temp file fails, mid-write. This both exercises the unlink-in-catch
    // path for real (a temp file genuinely exists on disk when the error hits)
    // and behaviourally proves atomicity: the failing write's bytes land on the
    // temp path, not on the target, so the last good file must survive intact.
    // A regression to writing straight to the target would corrupt it instead.
    const original = Buffer.from('original-good-cached-bytes');
    expect(await svc.write('u1', 'm1', '1.1', original)).toBe(true);

    const realWriteFile = fs.writeFile.bind(fs);
    const writeFileSpy = jest
      .spyOn(fs, 'writeFile')
      .mockImplementationOnce((async (path: any, data: any) => {
        const buf = data as Buffer;
        const half = buf.subarray(0, Math.floor(buf.length / 2));
        await realWriteFile(path, half);
        throw new Error('simulated failure mid-write');
      }) as any);

    const corrupting = Buffer.from('a-completely-different-and-longer-payload');
    const result = await svc.write('u1', 'm1', '1.1', corrupting);
    writeFileSpy.mockRestore();

    expect(result).toBe(false);
    // The cache must still serve the last good file, untouched.
    expect(await svc.read('u1', 'm1', '1.1')).toEqual(original);
    // And the half-written temp file from the failed attempt must not survive.
    const dir = dirname(svc.pathFor('u1', 'm1', '1.1'));
    const leftover = readdirSync(dir).filter(isTempFile);
    expect(leftover).toEqual([]);
  });

  it('uses unique temp file names per write call', async () => {
    // Temp file names must be unique per call (include process id + random) to prevent
    // concurrent writes to the same path from corrupting each other via shared temp.
    // Capture the actual temp name used on each write (fs.rename's first argument
    // is the temp path) and assert they differ across two writes to the same key —
    // a fixed `${full}.tmp` name would pass every other assertion in this file.
    const data1 = Buffer.from('first');
    const data2 = Buffer.from('second');
    const path = svc.pathFor('u1', 'm1', '1.1');
    const dir = dirname(path);

    const renameSpy = jest.spyOn(fs, 'rename');

    await svc.write('u1', 'm1', '1.1', data1);
    await svc.write('u1', 'm1', '1.1', data2);

    const tempNamesUsed = renameSpy.mock.calls.map(call => call[0]);
    renameSpy.mockRestore();

    expect(tempNamesUsed.length).toBe(2);
    expect(tempNamesUsed[0]).not.toEqual(tempNamesUsed[1]);

    // After both writes, only the target file exists, no .tmp-* files left behind
    const files = readdirSync(dir);
    const tmpFiles = files.filter(isTempFile);
    expect(tmpFiles).toEqual([]);

    // The final content is the second write
    const result = await svc.read('u1', 'm1', '1.1');
    expect(result).toEqual(data2);
  });

  it('uses atomic rename (verified by spy on fs.rename)', async () => {
    // Verify that the implementation uses fs.rename for atomicity, not direct write.
    // This distinguishes the correct atomic approach from a revert to plain writeFile.
    const renameSpy = jest.spyOn(fs, 'rename');
    const data = Buffer.from('atomic-test');

    const result = await svc.write('u1', 'm1', '1.1', data);

    expect(result).toBe(true);
    // fs.rename should have been called (indicating atomic rename was used)
    expect(renameSpy).toHaveBeenCalled();

    renameSpy.mockRestore();
  });
});
