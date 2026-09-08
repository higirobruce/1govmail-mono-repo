import { AttachmentEmbedWorkerService } from './attachment-embed-worker.service';
import { Readable } from 'node:stream';

const pdfPart = { id: '2', filename: 'report.txt', mimeType: 'text/plain', size: 1000 };

function makeService(overrides: {
  candidates?: any[];
  attachments?: any[];
  downloadText?: string;
} = {}) {
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue(overrides.candidates ?? []),
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn().mockResolvedValue([]),
    message: {
      findUnique: jest.fn().mockResolvedValue({ attachments: overrides.attachments ?? [pdfPart] }),
    },
    attachmentEmbedding: {
      deleteMany: jest.fn().mockReturnValue({}),
      create: jest.fn().mockReturnValue({}),
    },
  };
  const embedder: any = { model: 'bge-m3:latest', embed: jest.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])) };
  const mail: any = {
    getMessage: jest.fn().mockResolvedValue({}),
    downloadAttachment: jest.fn().mockResolvedValue({
      stream: Readable.from([Buffer.from(overrides.downloadText ?? 'quarterly totals: 42')]),
      contentType: 'text/plain',
      filename: 'report.txt',
    }),
  };
  return { svc: new AttachmentEmbedWorkerService(prisma, embedder, mail), prisma, embedder, mail };
}

const cand = { id: 'm1', userId: 'u1' };

describe('AttachmentEmbedWorkerService', () => {
  it('embeds eligible parts and reports one embedded message', async () => {
    const { svc, prisma, embedder } = makeService({ candidates: [cand] });
    const res = await svc.processTick();
    expect(res.embedded).toBe(1);
    expect(embedder.embed).toHaveBeenCalled();          // chunks were embedded
    expect(prisma.$transaction).toHaveBeenCalled();      // delete+insert transaction ran
  });

  it('hydrates via getMessage when the cached attachments array is empty', async () => {
    const { svc, prisma, mail } = makeService({ candidates: [cand] });
    prisma.message.findUnique
      .mockResolvedValueOnce({ attachments: [] })        // pre-hydration read
      .mockResolvedValueOnce({ attachments: [pdfPart] }); // post-hydration read
    await svc.processTick();
    expect(mail.getMessage).toHaveBeenCalledWith('u1', 'm1');
  });

  it('tombstones a message with no eligible parts', async () => {
    const { svc, prisma } = makeService({
      candidates: [cand],
      attachments: [{ id: '2', filename: 'photo.png', mimeType: 'image/png', size: 500 }],
    });
    const res = await svc.processTick();
    expect(res.tombstoned).toBe(1);
    expect(prisma.attachmentEmbedding.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ partId: '!', failed: true }) }),
    );
  });

  it('skips (not tombstones) on transient failure until the 3rd strike', async () => {
    const { svc, mail } = makeService({ candidates: [cand] });
    mail.downloadAttachment.mockRejectedValue(new Error('zimbra down'));
    expect((await svc.processTick()).skipped).toBe(1);
    expect((await svc.processTick()).skipped).toBe(1);
    expect((await svc.processTick()).tombstoned).toBe(1); // 3rd strike
  });

  it('caps chunks per attachment at 6', async () => {
    const { svc, embedder } = makeService({ candidates: [cand], downloadText: 'x'.repeat(100_000) });
    await svc.processTick();
    const chunks = embedder.embed.mock.calls[0][0];
    expect(chunks.length).toBeLessThanOrEqual(6);
  });
});
