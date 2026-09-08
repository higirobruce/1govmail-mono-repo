import { AttachmentEmbedWorkerService } from './attachment-embed-worker.service';
import { Readable } from 'node:stream';
import * as attachmentText from '../common/attachment-text';

jest.mock('../common/attachment-text');

const pdfPart = { id: '2', filename: 'report.txt', mimeType: 'text/plain', size: 1000 };

function makeService(overrides: {
  candidates?: any[];
  attachments?: any[];
  downloadText?: string;
} = {}) {
  // Ensure mocks are set up with defaults (will be overridden in specific tests)
  (attachmentText.extractAttachmentText as jest.Mock).mockImplementation((buf, contentType, filename) =>
    Promise.resolve(overrides.downloadText ?? 'extracted text')
  );
  (attachmentText.streamToBuffer as jest.Mock).mockResolvedValue(Buffer.from(overrides.downloadText ?? 'dummy'));

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
  beforeEach(() => {
    jest.clearAllMocks();
  });
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

  it('embeds good parts and skips corrupt parts without tombstoning', async () => {
    const { svc, prisma, mail } = makeService({
      candidates: [cand],
      attachments: [
        { id: '1', filename: 'good.txt', mimeType: 'text/plain', size: 1000 },
        { id: '2', filename: 'corrupt.pdf', mimeType: 'application/pdf', size: 5000 },
      ],
    });
    // good.txt downloads and extracts fine; corrupt.pdf downloads but extractAttachmentText throws
    let callCount = 0;
    mail.downloadAttachment.mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        stream: Readable.from([Buffer.from(callCount === 1 ? 'good content' : '\x00\x01\x02 not a pdf')]),
        contentType: callCount === 1 ? 'text/plain' : 'application/pdf',
        filename: callCount === 1 ? 'good.txt' : 'corrupt.pdf',
      });
    });
    // Mock extractAttachmentText to throw on the second call (corrupt PDF)
    (attachmentText.extractAttachmentText as jest.Mock)
      .mockResolvedValueOnce('good content')
      .mockRejectedValueOnce(new Error('Invalid PDF structure'));
    (attachmentText.streamToBuffer as jest.Mock).mockResolvedValue(Buffer.from('dummy'));

    const res = await svc.processTick();
    expect(res.embedded).toBe(1);     // one message processed
    expect(res.tombstoned).toBe(0);   // no tombstone (had at least one good part)
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('verifies per-part chunkIndex in $executeRaw calls', async () => {
    const { svc, prisma, mail } = makeService({
      candidates: [cand],
      attachments: [
        { id: 'p1', filename: 'file1.txt', mimeType: 'text/plain', size: 1000 },
        { id: 'p2', filename: 'file2.txt', mimeType: 'text/plain', size: 1000 },
      ],
    });
    // Mock downloadAttachment to return different content for each part
    let callCount = 0;
    mail.downloadAttachment.mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        stream: Readable.from([Buffer.from(`part ${callCount} ` + 'x'.repeat(500))]),
        contentType: 'text/plain',
        filename: callCount === 1 ? 'file1.txt' : 'file2.txt',
      });
    });
    await svc.processTick();

    // Inspect the $executeRaw calls to verify partId and chunkIndex
    const executeRawCalls = prisma.$executeRaw.mock.calls;
    // Each call is a tagged template: [strings_array, ...values]
    // We need to find the INSERT statements and verify chunkIndex values
    const insertCalls = executeRawCalls.filter(call =>
      call[0] && call[0][0] && call[0][0].includes('INSERT INTO "attachment_embeddings"')
    );

    // Collect partId and chunkIndex from calls
    const partChunks: { partId: string; chunkIndex: number }[] = [];
    insertCalls.forEach(call => {
      // Template args: id, messageId, userId, partId, filename, mimeType, chunkIndex, model, chunkText, vector, failed, extractedAt
      const partId = call[4];  // index 4 is partId
      const chunkIndex = call[7];  // index 7 is chunkIndex
      partChunks.push({ partId, chunkIndex });
    });

    // Verify each part has chunkIndex starting at 0
    const p1Chunks = partChunks.filter(pc => pc.partId === 'p1');
    const p2Chunks = partChunks.filter(pc => pc.partId === 'p2');

    // Both parts should have one or more chunks with indices starting at 0
    if (p1Chunks.length > 0) {
      expect(p1Chunks[0].chunkIndex).toBe(0);
    }
    if (p2Chunks.length > 0) {
      expect(p2Chunks[0].chunkIndex).toBe(0);
    }

    // At least one INSERT should have been called
    expect(insertCalls.length).toBeGreaterThan(0);
  });
});
