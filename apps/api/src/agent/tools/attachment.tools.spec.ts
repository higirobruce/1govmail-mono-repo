import { Readable } from 'node:stream';
import { z } from 'zod';
import { buildAttachmentTool, buildAttachmentSearchTool } from './attachment.tools';
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

describe('search_attachments', () => {
  const rows = [
    { messageId: 'm9', filename: 'contract.pdf', snippet: 'penalty clause 4.2 …', subject: 'VAPT contract', fromEmail: 'a@risa.gov.rw', receivedAt: new Date('2026-09-01T08:00:00Z') },
  ];
  const retrieval: any = { searchAttachments: jest.fn().mockResolvedValue(rows) };
  const ctx: any = { userId: 'u1', aliasFor: jest.fn().mockReturnValue('s1') };

  it('returns refs with the parent message id and (id …) exposure in content', async () => {
    const tool = buildAttachmentSearchTool(retrieval);
    const res = await tool.execute({ query: 'penalty clause' } as any, ctx);
    expect(res.refs?.[0]).toMatchObject({ type: 'mail', id: 'm9', alias: 's1' });
    expect(res.content).toContain('(id m9)');
    expect(res.content).toContain('contract.pdf');
  });

  it('advertised schema carries no pattern keys', () => {
    const tool = buildAttachmentSearchTool(retrieval);
    const json = JSON.stringify(z.toJSONSchema(tool.schema));
    expect(json).not.toContain('"pattern"');
  });
});
