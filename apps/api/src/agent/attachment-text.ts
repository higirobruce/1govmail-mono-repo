import mammoth from 'mammoth';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const TEXT_TYPES = /^(text\/|application\/(json|xml|csv))/;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

type PdfParseFn = (dataBuffer: Buffer) => Promise<{ text?: string }>;

export async function streamToBuffer(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
    total += b.length;
    if (total > maxBytes) throw new Error('attachment exceeds the 10MB read limit');
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export async function extractAttachmentText(buf: Buffer, mimeType: string, filename: string): Promise<string> {
  const lower = (filename ?? '').toLowerCase();
  if (mimeType === 'application/pdf' || lower.endsWith('.pdf')) {
    // Lazy require: pdf-parse's index.js runs debug code (reads a sample PDF
    // and writes a .txt file next to it) when `module.parent` is falsy. A
    // static top-level import would execute that side effect as soon as any
    // spec file pulls in this module — before any test even runs — which is
    // both slow and mutates node_modules. Requiring it here, only when a PDF
    // is actually parsed, keeps that code path inert during unrelated tests.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require('pdf-parse') as PdfParseFn;
    const parsed = await pdfParse(buf);
    return parsed.text ?? '';
  }
  if (mimeType === DOCX_MIME || lower.endsWith('.docx')) {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value ?? '';
  }
  if (TEXT_TYPES.test(mimeType) || /\.(txt|csv|md|log)$/.test(lower)) {
    return buf.toString('utf8');
  }
  throw new Error(
    `unsupported attachment type "${mimeType || 'unknown'}" — only PDF, DOCX and plain text attachments are readable`,
  );
}
