import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
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

  it('reports failure instead of throwing when the root is unwritable', async () => {
    // A broken cache must degrade to serving straight through.
    const ro = mkdtempSync(join(tmpdir(), 'imgcache-ro-'));
    chmodSync(ro, 0o500);
    const roSvc = new InlineImageCacheService(ro);
    await expect(roSvc.write('u1', 'm1', '1.1', Buffer.from('x'))).resolves.toBe(false);
    chmodSync(ro, 0o700);
    rmSync(ro, { recursive: true, force: true });
  });

  it('reports a miss instead of throwing when a read fails', async () => {
    const dir = join(root, 'u1', 'm1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '1.1'), 'ok');
    expect(existsSync(join(dir, '1.1'))).toBe(true);
    expect(await svc.read('u1', 'nope', '1.1')).toBeNull();
  });
});
