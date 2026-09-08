import { z } from 'zod';
import type { MailService } from '../../mail/mail.service';
import type { RetrievalService } from '../../chat/retrieval.service';
import type { ToolDef } from '../tool-registry';
import { extractAttachmentText, streamToBuffer, MAX_ATTACHMENT_BYTES } from '../../common/attachment-text';
import { toIsoDate } from '../dates';

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

export function buildAttachmentSearchTool(retrieval: RetrievalService): ToolDef {
  return {
    name: 'search_attachments',
    description:
      'Semantic search INSIDE email attachments (PDF, DOCX and text file contents). Use when the user asks about the contents of a file — e.g. a term that would appear in a report or contract rather than the email body. Each result line includes the parent message id — pass THAT id to read_email or read_attachment, never the [sN] alias; never invent ids.',
    mode: 'read',
    resultBudget: 3000,
    schema: z.object({ query: z.string().min(2).max(200) }),
    async execute(args: any, ctx) {
      const rows = await retrieval.searchAttachments(ctx.userId, args.query, 8);
      const refs = rows.map((r) => ({
        alias: ctx.aliasFor('mail', r.messageId),
        type: 'mail' as const,
        id: r.messageId,
        title: r.subject,
        date: toIsoDate(r.receivedAt),
        snippet: `${r.filename}: ${r.snippet}`.slice(0, 160),
        injectionSuspected: false,
      }));
      const content = rows.length
        ? rows
            .map((r, i) =>
              `[${refs[i].alias}] (id ${r.messageId}) attachment "${r.filename}" on "${r.subject ?? '(no subject)'}" from ${r.fromEmail} on ${refs[i].date}\n${r.snippet}`,
            )
            .join('\n\n')
        : 'No attachment content matched.';
      return { summary: `${rows.length} attachment match(es)`, content, refs };
    },
  };
}
