import { z } from 'zod';
import type { MailService } from '../../mail/mail.service';
import type { ToolDef } from '../tool-registry';
import { extractAttachmentText, streamToBuffer, MAX_ATTACHMENT_BYTES } from '../../common/attachment-text';

export function buildAttachmentTool(mail: MailService): ToolDef {
  return {
    name: 'read_attachment',
    description:
      'Read the text of one email attachment by message id and MIME part (both listed by read_email). Supports PDF, DOCX and plain-text files up to 10MB. Images and spreadsheets are not readable.',
    mode: 'read',
    resultBudget: 4000,
    schema: z.object({ messageId: z.string().min(1), part: z.string().min(1) }),
    async execute(args: any, ctx) {
      const { stream, contentType, filename } = await mail.downloadAttachment(
        ctx.userId,
        args.messageId,
        args.part,
      );
      const buf = await streamToBuffer(stream, MAX_ATTACHMENT_BYTES);
      const text = await extractAttachmentText(buf, contentType, filename);
      return {
        summary: `Read attachment "${filename}"`,
        content: `ATTACHMENT "${filename}" (${contentType}) from message ${args.messageId}:\n\n${text || '(no extractable text)'}`,
      };
    },
  };
}
