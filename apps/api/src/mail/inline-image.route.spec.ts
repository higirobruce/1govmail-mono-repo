import { NotFoundException } from '@nestjs/common';
import { MailService } from './mail.service';
import { InlineImageCacheService } from './inline-image-cache.service';

function makeService(opts: { cacheHit?: Buffer; message?: any } = {}) {
  const cache = {
    read: jest.fn().mockResolvedValue(opts.cacheHit ?? null),
    write: jest.fn().mockResolvedValue(true),
  } as unknown as InlineImageCacheService;

  const provider = {
    downloadAttachmentBuffer: jest.fn().mockResolvedValue({
      data: Buffer.from('fetched'), contentType: 'image/png',
    }),
  };
  const prisma: any = {
    // authToken/tokenExpiry included so MailService.getUser's Zimbra-session
    // gate (unrelated to what this suite tests) doesn't 401 every miss path.
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1', email: 'u1@x.rw', authToken: 'tok', tokenExpiry: null }) },
    message: {
      findFirst: jest.fn().mockResolvedValue(
        opts.message === undefined
          ? { id: 'm1', userId: 'u1', zimbraId: 'z1',
              inlineImages: [{ cid: 'c1', partId: '1.1.2', mimeType: 'image/png' }] }
          : opts.message,
      ),
    },
  };
  const resolver = { forUser: () => provider } as any;
  // Match mail.service.spec.ts, which constructs the service for real rather
  // than reaching past the constructor — that is what catches a missing arg.
  const svc = new MailService(prisma, resolver, {} as any, {} as any, cache);
  return { svc, cache, provider, prisma };
}

describe('MailService.getInlineImage', () => {
  it('serves from the cache without touching the provider', async () => {
    const { svc, provider } = makeService({ cacheHit: Buffer.from('cached') });
    const r = await svc.getInlineImage('u1', 'm1', '1.1.2');
    expect(r.data.toString()).toBe('cached');
    expect(r.cached).toBe(true);
    expect(provider.downloadAttachmentBuffer).not.toHaveBeenCalled();
  });

  it('fetches and writes on a miss', async () => {
    const { svc, cache, provider } = makeService();
    const r = await svc.getInlineImage('u1', 'm1', '1.1.2');
    expect(r.data.toString()).toBe('fetched');
    expect(r.cached).toBe(false);
    expect(provider.downloadAttachmentBuffer).toHaveBeenCalledTimes(1);
    expect(cache.write).toHaveBeenCalledWith('u1', 'm1', '1.1.2', expect.any(Buffer));
  });

  it('still serves when the cache write fails', async () => {
    const { svc, cache } = makeService();
    (cache.write as jest.Mock).mockResolvedValue(false);
    const r = await svc.getInlineImage('u1', 'm1', '1.1.2');
    expect(r.data.toString()).toBe('fetched');
  });

  it('refuses a message that is not the caller own', async () => {
    const { svc } = makeService({ message: null });
    await expect(svc.getInlineImage('u1', 'someone-else', '1.1.2'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a part that the message does not declare as an inline image', async () => {
    // Without this the route is a general attachment reader wearing a cache.
    const { svc, provider } = makeService();
    await expect(svc.getInlineImage('u1', 'm1', '9.9.9'))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(provider.downloadAttachmentBuffer).not.toHaveBeenCalled();
  });
});
