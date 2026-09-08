import { Readable } from 'node:stream';
import { extractAttachmentText, streamToBuffer } from './attachment-text';

describe('extractAttachmentText', () => {
  it('decodes plain text directly', async () => {
    const text = await extractAttachmentText(Buffer.from('col1,col2\n1,2'), 'text/csv', 'data.csv');
    expect(text).toBe('col1,col2\n1,2');
  });

  it('refuses unsupported types with a clear message', async () => {
    await expect(
      extractAttachmentText(Buffer.from([0xff, 0xd8]), 'image/jpeg', 'scan.jpg'),
    ).rejects.toThrow(/only PDF, DOCX and plain text/);
  });
});

describe('streamToBuffer', () => {
  it('collects a stream into a buffer', async () => {
    const buf = await streamToBuffer(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), 100);
    expect(buf.toString()).toBe('abcd');
  });

  it('throws when the stream exceeds maxBytes', async () => {
    await expect(streamToBuffer(Readable.from([Buffer.alloc(200)]), 100)).rejects.toThrow(/10MB|limit/);
  });
});
