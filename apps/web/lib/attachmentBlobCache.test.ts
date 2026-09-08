import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getAttachmentUrl,
  revokeMessageAttachments,
  clearAttachmentBlobCache,
} from './attachmentBlobCache';

describe('attachmentBlobCache', () => {
  let revoked: string[];

  beforeEach(() => {
    clearAttachmentBlobCache();
    revoked = [];
    vi.stubGlobal('URL', {
      ...URL,
      revokeObjectURL: (u: string) => revoked.push(u),
    });
  });

  it('fetches once and serves repeat requests for the same message+part from cache', async () => {
    const fetcher = vi.fn().mockResolvedValue('blob:one');

    const a = await getAttachmentUrl('m1', '2', fetcher);
    const b = await getAttachmentUrl('m1', '2', fetcher);

    expect(a).toBe('blob:one');
    expect(b).toBe('blob:one');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates concurrent requests for the same attachment', async () => {
    let resolve!: (u: string) => void;
    const fetcher = vi.fn().mockReturnValue(new Promise<string>((r) => (resolve = r)));

    const p1 = getAttachmentUrl('m1', '2', fetcher);
    const p2 = getAttachmentUrl('m1', '2', fetcher);
    resolve('blob:one');

    expect(await p1).toBe('blob:one');
    expect(await p2).toBe('blob:one');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('caches per part — different parts of one message fetch separately', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce('blob:one')
      .mockResolvedValueOnce('blob:two');

    expect(await getAttachmentUrl('m1', '2', fetcher)).toBe('blob:one');
    expect(await getAttachmentUrl('m1', '3', fetcher)).toBe('blob:two');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed fetch — a retry fetches again', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValueOnce('blob:one');

    await expect(getAttachmentUrl('m1', '2', fetcher)).rejects.toThrow('net');
    expect(await getAttachmentUrl('m1', '2', fetcher)).toBe('blob:one');
  });

  it('revokeMessageAttachments revokes and forgets only that message\'s URLs', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce('blob:m1-a')
      .mockResolvedValueOnce('blob:m1-b')
      .mockResolvedValueOnce('blob:m2-a')
      .mockResolvedValueOnce('blob:m1-a2');
    await getAttachmentUrl('m1', '2', fetcher);
    await getAttachmentUrl('m1', '3', fetcher);
    await getAttachmentUrl('m2', '2', fetcher);

    revokeMessageAttachments('m1');

    expect(revoked.sort()).toEqual(['blob:m1-a', 'blob:m1-b']);
    // m2 stays cached; m1 refetches
    expect(await getAttachmentUrl('m2', '2', fetcher)).toBe('blob:m2-a');
    expect(await getAttachmentUrl('m1', '2', fetcher)).toBe('blob:m1-a2');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('evicts (and revokes) the least-recently-used entry past the cap of 20', async () => {
    for (let i = 0; i < 20; i++) {
      await getAttachmentUrl('m1', String(i), () => Promise.resolve(`blob:${i}`));
    }
    // Touch part 0 so part 1 is the LRU.
    await getAttachmentUrl('m1', '0', () => Promise.resolve('blob:new-0'));
    await getAttachmentUrl('m1', '20', () => Promise.resolve('blob:20'));

    expect(revoked).toEqual(['blob:1']);
  });

  it('clearAttachmentBlobCache revokes everything', async () => {
    await getAttachmentUrl('m1', '2', () => Promise.resolve('blob:a'));
    await getAttachmentUrl('m2', '2', () => Promise.resolve('blob:b'));

    clearAttachmentBlobCache();

    expect(revoked.sort()).toEqual(['blob:a', 'blob:b']);
  });
});
