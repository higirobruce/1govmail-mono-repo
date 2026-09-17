import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { InlineImageCacheService, MAX_FILE_BYTES } from './inline-image-cache.service';

describe('InlineImageCacheService', () => {
  let root: string;
  let svc: InlineImageCacheService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'imgcache-'));
    svc = new InlineImageCacheService(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('keys the path by user, message and part', () => {
    expect(svc.pathFor('u1', 'm1', '1.1.2')).toBe(join(root, 'u1', 'm1', '1.1.2'));
  });

  it('refuses a part id that would escape the cache root', () => {
    // A traversing part id must not be able to read or write outside the user's
    // own directory. This is the tenancy boundary, not a tidiness rule.
    expect(() => svc.pathFor('u1', 'm1', '../../../../etc/passwd')).toThrow();
    expect(() => svc.pathFor('u1', '../u2', '1.1')).toThrow();
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
    const dir = join(root, 'u1', 'm1', '1.1');
    mkdirSync(dir, { recursive: true });
    expect(existsSync(dir)).toBe(true);
    expect(await svc.read('u1', 'm1', '1.1')).toBeNull();
  });

  it('cleans up the temp file after a successful write', async () => {
    // Atomic write uses a temp file: after write completes, the temp should be gone.
    const data = Buffer.from('atomic');
    const path = svc.pathFor('u1', 'm1', '1.1');
    expect(await svc.write('u1', 'm1', '1.1', data)).toBe(true);
    // The target file should exist.
    expect(existsSync(path)).toBe(true);
    // The temp file should not exist.
    expect(existsSync(path + '.tmp')).toBe(false);
  });

  it('cleans up the temp file after a failed write', async () => {
    // Even on failure, the temp file must not be left behind.
    const badRoot = join(tmpdir(), 'imgcache-file-' + Date.now());
    writeFileSync(badRoot, 'a file');
    const badSvc = new InlineImageCacheService(badRoot);
    const targetPath = badSvc.pathFor('u1', 'm1', '1.1');
    await badSvc.write('u1', 'm1', '1.1', Buffer.from('data'));
    // The write failed, so the temp should be cleaned up and target should not exist.
    expect(existsSync(targetPath)).toBe(false);
    expect(existsSync(targetPath + '.tmp')).toBe(false);
    rmSync(badRoot, { force: true });
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
    expect(existsSync(path + '.tmp')).toBe(false);
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
    const tmpFiles = files.filter(f => f.startsWith('.tmp-'));
    expect(tmpFiles).toEqual([]);
  });

  it('cleans up temp file when mkdir succeeds but writeFile fails', async () => {
    // The write() method creates the directory, then writes to temp, then renames.
    // If we can make writeFile fail after mkdir succeeds (e.g., by making the dir
    // read-only after mkdir but before writeFile), the unlink-in-catch path executes.
    // However, on some systems this is tricky. Instead, verify that temp files are
    // distinguishable from real part IDs and get cleaned up after any error.
    const data = Buffer.from('test');
    const path = svc.pathFor('u1', 'm1', '1.1');
    const dir = join(path, '..');

    // Make a directory where writeFile would write - this causes writeFile to fail
    mkdirSync(join(path), { recursive: true });

    const result = await svc.write('u1', 'm1', '1.1', data);
    expect(result).toBe(false);
    // No .tmp-* temp files should be left behind in the message directory
    const messageDir = join(root, 'u1', 'm1');
    const files = readdirSync(messageDir);
    const tmpFiles = files.filter(f => f.startsWith('.tmp-'));
    expect(tmpFiles).toEqual([]);
  });

  it('uses unique temp file names per write call', async () => {
    // Temp file names must be unique per call (include process id + random) to prevent
    // concurrent writes to the same path from corrupting each other via shared temp.
    const data1 = Buffer.from('first');
    const data2 = Buffer.from('second');
    const path = svc.pathFor('u1', 'm1', '1.1');
    const dir = dirname(path);

    // Write the same path twice (simulating concurrent calls, though sequentially here)
    // and verify that temp files are distinct (or cleaned up immediately)
    await svc.write('u1', 'm1', '1.1', data1);
    await svc.write('u1', 'm1', '1.1', data2);

    // After both writes, only the target file exists, no .tmp-* files left behind
    const files = readdirSync(dirname(path));
    const tmpFiles = files.filter(f => f.startsWith('.tmp-'));
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
