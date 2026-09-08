import { Readable } from 'node:stream';
import { buildAttachmentTool } from './attachment.tools';
import type { ToolContext } from '../tool-registry';

function makeCtx(): ToolContext {
  let n = 0;
  return { userId: 'u1', userEmail: 'u1@x.rw', aliasFor: () => `s${++n}`, emitChart: jest.fn() };
}

describe('read_attachment', () => {
  it('downloads, extracts and labels the text', async () => {
    const mail = {
      downloadAttachment: jest.fn().mockResolvedValue({
        stream: Readable.from([Buffer.from('minutes of the meeting')]),
        contentType: 'text/plain',
        filename: 'minutes.txt',
      }),
    } as any;
    const tool = buildAttachmentTool(mail);
    const res = await tool.execute({ messageId: 'm1', part: '2' }, makeCtx());
    expect(mail.downloadAttachment).toHaveBeenCalledWith('u1', 'm1', '2');
    expect(res.summary).toContain('minutes.txt');
    expect(res.content).toContain('minutes of the meeting');
    expect(res.content).toContain('ATTACHMENT "minutes.txt"');
  });

  it('surfaces unsupported-type errors as tool errors', async () => {
    const mail = {
      downloadAttachment: jest.fn().mockResolvedValue({
        stream: Readable.from([Buffer.from('x')]),
        contentType: 'image/png',
        filename: 'chart.png',
      }),
    } as any;
    await expect(buildAttachmentTool(mail).execute({ messageId: 'm1', part: '3' }, makeCtx())).rejects.toThrow(
      /only PDF, DOCX and plain text/,
    );
  });
});
